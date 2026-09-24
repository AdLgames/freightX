import { Suspense, lazy, useEffect, useState, type ComponentType } from 'react';
import type { MapState } from '../../services/tracking/map-state';

/**
 * M9 (ADR-0017) — the map is the only part of tracking that needs JavaScript. The server renders
 * a placeholder; after hydration this component lazy-loads `tracking-map.client.tsx` (MapLibre +
 * deck.gl), which Vite splits into its own chunk, so the map code is downloaded only on the
 * tracking detail route and only in the browser.
 */
export interface TrackingMapProps {
  styleUrl: string;
  /** Where the client fetches fresh state every 60 s (org-scoped, rate-limited). */
  stateUrl: string;
  initialState: MapState;
  /** Home only: poll this URL (the server's aisstream relay) and overlay live AIS traffic. */
  ais?: { url: string } | null;
}

const LazyMap = lazy(() =>
  import('./tracking-map.client').then((m) => ({ default: m.TrackingMapClient })),
) as ComponentType<TrackingMapProps>;

export function TrackingMap(props: TrackingMapProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const placeholder = (
    <div className="tracking-map placeholder" role="img" aria-label="Map of tracked containers">
      <p className="muted">
        {ready ? 'Loading map…' : 'The map needs JavaScript. The timeline above works without it.'}
      </p>
    </div>
  );
  if (!ready) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <LazyMap {...props} />
    </Suspense>
  );
}
