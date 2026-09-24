import { IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { MapboxOverlay } from '@deck.gl/mapbox';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import {
  AIS_UK_BOUNDS,
  decodeAisVessels,
  upsertAisVessel,
  type AisSnapshotResponse,
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
 * With `ais` (Home, `AISSTREAM_API_KEY`) a second ScatterplotLayer draws live AIS traffic around
 * the UK as small lime dots: the picture around the organisation's ships, never its ships. The
 * browser polls the server's relay (`/app/api/ais`, which holds the aisstream socket) every few
 * seconds and keeps a bounded cache (lib/ais-client).
 */
const REFRESH_MS = 60_000;
const GLIDE_MS = 1_500;
const AIS_POLL_MS = 10_000;

const SHIP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
  '<path d="M24 3 L34 20 L34 38 Q24 46 14 38 L14 20 Z" fill="#4da3ff" stroke="#ffffff" stroke-width="2.5"/>' +
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
      getColor: [77, 163, 255, 230],
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
      getFillColor: (r) => (r.capped ? [170, 180, 195, 60] : [77, 163, 255, 45]),
      getLineColor: [77, 163, 255, 160],
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
  const [aisError, setAisError] = useState<string | null>(null);
  const aisUrl = ais?.url ?? null;

  // Live AIS traffic (Home): poll the relay; the cache is pruned on every merge.
  useEffect(() => {
    if (!aisUrl) return;
    const cache = aisRef.current;
    let cancelled = false;
    let since = 0;
    const poll = async () => {
      try {
        const q = since > 0 ? `?since=${since}` : '';
        const res = await fetch(`${aisUrl}${q}`, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (cancelled) return;
        if (!res.ok) {
          setAisStatus('down');
          setAisError(null);
          return;
        }
        const body = (await res.json()) as AisSnapshotResponse;
        if (cancelled) return;
        const now = Date.now();
        for (const v of decodeAisVessels(body.v)) upsertAisVessel(cache, v, now);
        since = Math.max(since, body.collectedAt);
        setAisCount(cache.size);
        if (body.status === 'error') {
          setAisStatus('down');
          setAisError(body.error);
        } else {
          setAisStatus(body.status === 'warming' && cache.size === 0 ? 'connecting' : 'live');
          setAisError(null);
        }
      } catch {
        if (!cancelled) setAisStatus('down');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), AIS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      cache.clear();
    };
  }, [aisUrl]);

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
          'line-color': '#4da3ff',
          'line-width': 2,
          'line-dasharray': [2, 3],
          'line-opacity': 0.8,
        },
        layout: { 'line-cap': 'round' },
      });
      fitBounds(map, stateRef.current, aisUrl !== null);
    });
    // The Home panel sizes the map with flex, so the container can still be collapsed when the
    // style loads and the initial fit lands on a near-empty canvas; refit on the first real size.
    let fittedAt = { w: 0, h: 0 };
    map.on('load', () => {
      fittedAt = { w: el.clientWidth, h: el.clientHeight };
    });
    map.on('resize', () => {
      if (
        (fittedAt.w < 100 || fittedAt.h < 100) &&
        el.clientWidth >= 100 &&
        el.clientHeight >= 100
      ) {
        fittedAt = { w: el.clientWidth, h: el.clientHeight };
        fitBounds(map, stateRef.current, aisUrl !== null);
      }
    });
    raf = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(raf);
      map.remove();
    };
  }, [styleUrl, aisUrl]);

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
                : aisError
                  ? `Live AIS refused: ${aisError}`
                  : 'Live AIS unavailable, retrying…'}
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
