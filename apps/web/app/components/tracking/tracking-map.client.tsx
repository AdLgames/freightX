import { IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import {
  AIS_STREAM_URL,
  AIS_UK_BOUNDS,
  aisSubscribeMessage,
  parseAisMessage,
  upsertAisVessel,
  type AisVessel,
} from '../../lib/ais-client';
import {
  advanceClient,
  haversineKm,
  uncertaintyRadiusKm,
  type GeoPoint,
} from '../../lib/kinematics-client';
import type { MapContainerState, MapState } from '../../services/tracking/map-state';
import type { TrackingMapProps } from './tracking-map';

/**
 * M9 (ADR-0017) — MapLibre GL basemap + deck.gl overlay:
 *   - ScatterplotLayer  uncertainty circle (radius in metres from km)
 *   - IconLayer         the ship, an inline SVG data URL (no external asset), rotated to heading
 *   - PathLayer         solid line of REAL points: event coordinates then the last AIS ping
 *   - MapLibre line     dashed "expected route": the lane path ahead of the reckoned position
 * Between fetches the browser advances the server's reckoned position with the same formulas
 * and cap (`lib/kinematics-client.ts`); when fresh state arrives the icon glides to the new
 * position over ~1.5 s instead of jumping. Nothing here is stored: only real pings carry a
 * `positionSource`, and extrapolated points are display-only.
 *
 * With `ais` (Home, `AISSTREAM_API_KEY`) a second ScatterplotLayer draws live AIS traffic from
 * aisstream.io around the UK as small lime dots: the picture around the organisation's ships,
 * never its ships. The socket reconnects with a backoff and the cache is bounded (lib/ais-client).
 */
const REFRESH_MS = 60_000;
const GLIDE_MS = 1_500;
const AIS_RECONNECT_MS = 15_000;
const AIS_COUNT_MS = 2_000;

const SHIP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
  '<path d="M24 3 L34 20 L34 38 Q24 46 14 38 L14 20 Z" fill="#0b5fa5" stroke="#ffffff" stroke-width="2.5"/>' +
  '<circle cx="24" cy="26" r="4" fill="#ffffff"/></svg>';
const SHIP_ICON_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SHIP_SVG)}`;

interface Live {
  container: MapContainerState;
  /** Position being drawn this frame. */
  point: GeoPoint;
  remaining: GeoPoint[];
  extrapolatedMs: number;
  capped: boolean;
  radiusKm: number;
  /** Glide: from → target over GLIDE_MS after a fetch. */
  glideFrom: GeoPoint | null;
  glideStartedAt: number;
}

const startPoint = (c: MapContainerState): GeoPoint | null =>
  c.reckoned
    ? { lat: c.reckoned.lat, lon: c.reckoned.lon }
    : c.ping
      ? { lat: c.ping.lat, lon: c.ping.lon }
      : null;

/** Advances every container from the server snapshot by the time elapsed since it was computed. */
const stepAll = (
  state: MapState,
  previous: Map<string, Live>,
  nowMs: number,
): Map<string, Live> => {
  const serverNowMs = Date.parse(state.serverNow);
  const elapsed = Math.max(0, nowMs - serverNowMs);
  const out = new Map<string, Live>();
  for (const c of state.containers) {
    const start = startPoint(c);
    if (!start || !c.ping) continue;
    const frozen =
      !c.reckoned ||
      c.reckoned.capped ||
      c.vessel?.pollState === 'STALE' ||
      c.vessel?.pollState === 'DOCKED';
    const adv = frozen
      ? {
          point: start,
          remaining: c.expectedPath,
          extrapolatedMs: c.reckoned?.extrapolatedMs ?? 0,
          capped: c.reckoned?.capped ?? false,
        }
      : advanceClient(
          {
            start,
            serverExtrapolatedMs: c.reckoned?.extrapolatedMs ?? 0,
            maxExtrapolationMs: c.maxExtrapolationMs,
            speedKnots: c.ping.speedKnots,
            headingDeg: c.ping.headingDeg,
            expectedPath: c.expectedPath,
          },
          elapsed,
        );
    const prev = previous.get(c.containerId);
    let point = adv.point;
    let glideFrom = prev?.glideFrom ?? null;
    let glideStartedAt = prev?.glideStartedAt ?? 0;
    if (prev && prev.container !== c) {
      // New server snapshot: glide from where we were to where we should be.
      glideFrom = prev.point;
      glideStartedAt = nowMs;
    }
    if (glideFrom) {
      const t = Math.min(1, (nowMs - glideStartedAt) / GLIDE_MS);
      const ease = 1 - (1 - t) * (1 - t);
      point = {
        lat: glideFrom.lat + (adv.point.lat - glideFrom.lat) * ease,
        lon: glideFrom.lon + (adv.point.lon - glideFrom.lon) * ease,
      };
      if (t >= 1) glideFrom = null;
    }
    out.set(c.containerId, {
      container: c,
      point,
      remaining: adv.remaining.length ? adv.remaining : c.expectedPath,
      extrapolatedMs: adv.extrapolatedMs,
      capped: adv.capped || (c.reckoned?.capped ?? false),
      radiusKm: uncertaintyRadiusKm(adv.extrapolatedMs, c.ping.speedKnots),
      glideFrom,
      glideStartedAt,
    });
  }
  return out;
};

const toLonLat = (p: GeoPoint): [number, number] => [p.lon, p.lat];

const buildLayers = (live: Map<string, Live>, ais: readonly AisVessel[]) => {
  const rows = [...live.values()];
  return [
    new ScatterplotLayer<AisVessel>({
      id: 'ais-traffic',
      data: ais,
      getPosition: (v) => [v.lon, v.lat],
      getRadius: 400,
      radiusUnits: 'meters',
      radiusMinPixels: 2.5,
      radiusMaxPixels: 7,
      getFillColor: [197, 240, 66, 190],
      pickable: false,
    }),
    new PathLayer<Live>({
      id: 'actual-route',
      data: rows.filter((r) => r.container.actualPath.length >= 2),
      getPath: (r) => r.container.actualPath.map(toLonLat),
      getColor: [11, 95, 165, 220],
      getWidth: 3,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    }),
    new ScatterplotLayer<Live>({
      id: 'uncertainty',
      data: rows,
      getPosition: (r) => toLonLat(r.point),
      getRadius: (r) => r.radiusKm * 1000,
      radiusUnits: 'meters',
      radiusMinPixels: 6,
      getFillColor: (r) => (r.capped ? [120, 120, 120, 50] : [11, 95, 165, 40]),
      getLineColor: [11, 95, 165, 140],
      lineWidthMinPixels: 1,
      stroked: true,
    }),
    new IconLayer<Live>({
      id: 'ships',
      data: rows,
      getPosition: (r) => toLonLat(r.point),
      getIcon: () => ({
        url: SHIP_ICON_URL,
        width: 48,
        height: 48,
        anchorX: 24,
        anchorY: 24,
        mask: false,
      }),
      getSize: 28,
      sizeUnits: 'pixels',
      getAngle: (r) => -(r.container.ping?.headingDeg ?? 0),
      pickable: true,
    }),
  ];
};

const expectedRouteGeoJson = (live: Map<string, Live>): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: [...live.values()]
    .filter((r) => r.remaining.length >= 2)
    .map((r) => ({
      type: 'Feature',
      properties: { containerId: r.container.containerId },
      geometry: {
        type: 'LineString',
        coordinates: [r.point, ...r.remaining.slice(1)].map(toLonLat),
      },
    })),
});

const fitBounds = (map: maplibregl.Map, state: MapState, aisEnabled: boolean) => {
  const pts: GeoPoint[] = [];
  for (const c of state.containers) {
    pts.push(...c.actualPath, ...c.expectedPath);
    const s = startPoint(c);
    if (s) pts.push(s);
    if (c.destination) pts.push({ lat: c.destination.lat, lon: c.destination.lon });
  }
  if (pts.length === 0) {
    if (aisEnabled) {
      map.fitBounds(
        [
          [AIS_UK_BOUNDS[0][1], AIS_UK_BOUNDS[0][0]],
          [AIS_UK_BOUNDS[1][1], AIS_UK_BOUNDS[1][0]],
        ],
        { padding: 24, duration: 0 },
      );
    }
    return;
  }
  if (pts.length === 1 || pts.every((p) => haversineKm(p, pts[0]!) < 1)) {
    map.jumpTo({ center: toLonLat(pts[0]!), zoom: 5 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds(toLonLat(pts[0]!), toLonLat(pts[0]!));
  for (const p of pts) bounds.extend(toLonLat(p));
  map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 0 });
};

export function TrackingMapClient({ styleUrl, stateUrl, initialState, ais }: TrackingMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<MapState>(initialState);
  const stateRef = useRef<MapState>(initialState);
  const [status, setStatus] = useState<'ok' | 'refresh-failed'>('ok');
  const [selected, setSelected] = useState<Live | null>(null);
  const aisRef = useRef<Map<string, AisVessel>>(new Map());
  const [aisCount, setAisCount] = useState(0);
  const [aisStatus, setAisStatus] = useState<'off' | 'connecting' | 'live' | 'down'>(
    ais ? 'connecting' : 'off',
  );
  const aisKey = ais?.apiKey ?? null;

  // Live AIS traffic (Home): one socket, reconnecting; the cache is pruned on every report.
  useEffect(() => {
    if (!aisKey) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;
    const connect = () => {
      if (closed) return;
      setAisStatus('connecting');
      try {
        socket = new WebSocket(AIS_STREAM_URL);
      } catch {
        setAisStatus('down');
        retry = window.setTimeout(connect, AIS_RECONNECT_MS);
        return;
      }
      socket.onopen = () => {
        socket?.send(aisSubscribeMessage(aisKey));
        setAisStatus('live');
      };
      socket.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        const now = Date.now();
        const v = parseAisMessage(ev.data, now);
        if (v) upsertAisVessel(aisRef.current, v, now);
      };
      socket.onerror = () => setAisStatus('down');
      socket.onclose = () => {
        if (closed) return;
        setAisStatus('down');
        retry = window.setTimeout(connect, AIS_RECONNECT_MS);
      };
    };
    connect();
    const counter = window.setInterval(() => setAisCount(aisRef.current.size), AIS_COUNT_MS);
    return () => {
      closed = true;
      window.clearInterval(counter);
      if (retry !== undefined) window.clearTimeout(retry);
      socket?.close();
      aisRef.current.clear();
    };
  }, [aisKey]);

  // Periodic refresh (60 s). The server recomputes dead reckoning; the client glides to it.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(stateUrl, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as MapState;
        if (!cancelled) {
          stateRef.current = next;
          setState(next);
          setStatus('ok');
        }
      } catch {
        if (!cancelled) setStatus('refresh-failed');
      }
    };
    const id = window.setInterval(() => void tick(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [stateUrl]);

  // Map + overlay + animation loop.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const map = new maplibregl.Map({
      container: el,
      style: styleUrl,
      center: [40, 20],
      zoom: 2,
      attributionControl: {},
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [],
      onClick: (info) => setSelected((info.object as Live | undefined) ?? null),
    });
    map.addControl(overlay);
    let live = new Map<string, Live>();
    let raf = 0;
    let loaded = false;

    const frame = () => {
      live = stepAll(stateRef.current, live, Date.now());
      overlay.setProps({ layers: buildLayers(live, [...aisRef.current.values()]) });
      if (loaded) {
        const src = map.getSource<GeoJSONSource>('expected-route');
        src?.setData(expectedRouteGeoJson(live));
      }
      raf = window.requestAnimationFrame(frame);
    };

    map.on('load', () => {
      loaded = true;
      map.addSource('expected-route', { type: 'geojson', data: expectedRouteGeoJson(live) });
      map.addLayer({
        id: 'expected-route',
        type: 'line',
        source: 'expected-route',
        paint: {
          'line-color': '#0b5fa5',
          'line-width': 2,
          'line-dasharray': [2, 3],
          'line-opacity': 0.8,
        },
        layout: { 'line-cap': 'round' },
      });
      fitBounds(map, stateRef.current, aisKey !== null);
    });
    raf = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(raf);
      map.remove();
    };
  }, [styleUrl, aisKey]);

  const tracked = state.containers.filter((c) => c.ping);
  return (
    <div className="tracking-map-wrap">
      <div
        ref={containerRef}
        className="tracking-map"
        aria-label="Map of tracked containers"
        role="img"
      />
      <div className="tracking-map-legend">
        <span>
          <i className="legend-line solid" /> Actual (events and AIS pings)
        </span>
        <span>
          <i className="legend-line dashed" /> Expected route (estimated, along the shipping lane)
        </span>
        <span>
          <i className="legend-circle" /> Position uncertainty
        </span>
        {aisStatus !== 'off' ? (
          <span>
            <i className="legend-dot ais" />{' '}
            {aisStatus === 'live'
              ? `Live AIS traffic · ${aisCount} vessel${aisCount === 1 ? '' : 's'}`
              : aisStatus === 'connecting'
                ? 'Connecting to live AIS…'
                : 'Live AIS unavailable, reconnecting…'}
          </span>
        ) : null}
        {status === 'refresh-failed' ? (
          <span className="field-error">Live refresh failed; showing the last known state.</span>
        ) : null}
        {tracked.length === 0 ? <span className="muted">No vessel positions yet.</span> : null}
        {selected ? (
          <span>
            <strong>{selected.container.containerNumber}</strong>
            {selected.container.vessel?.name ? ` on ${selected.container.vessel.name}` : ''} ·{' '}
            {selected.capped
              ? `last seen ${new Date(selected.container.ping?.positionAt ?? state.serverNow).toISOString().slice(0, 16).replace('T', ' ')} UTC`
              : `estimated, ±${selected.radiusKm.toFixed(0)} km`}
            {selected.container.ping?.positionSource
              ? ` · source ${selected.container.ping.positionSource}`
              : ''}
          </span>
        ) : null}
      </div>
    </div>
  );
}
