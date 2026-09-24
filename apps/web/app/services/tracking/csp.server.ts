import type { CspAdditions } from '../security-headers.server';

/**
 * M9 (ADR-0017) — CSP additions for the tracking detail route only. MapLibre fetches the style,
 * tiles, glyphs and sprites from the style's origin (and any extra tile origins), runs its
 * workers from blob: URLs, and deck.gl's IconLayer loads the ship icon from an inline SVG
 * data: URL. Nothing here touches script-src; the global policy is unchanged elsewhere.
 *
 * If a browser reports a `style-src` violation from the map, add `'style-src': ["'self'"]`
 * plus the offending source here rather than globally (see apps/web README, "Tracking (M9)").
 */
export const mapCspAdditions = (
  mapStyleUrl: string,
  extraOrigins: readonly string[] = [],
): CspAdditions => {
  let origin: string | null = null;
  try {
    const u = new URL(mapStyleUrl);
    origin = u.protocol === 'https:' ? u.origin : null;
  } catch {
    origin = null;
  }
  const hosts = [...new Set([origin, ...extraOrigins].filter((o): o is string => o !== null))];
  return {
    'connect-src': hosts,
    'img-src': [...hosts, 'data:', 'blob:'],
    'worker-src': ['blob:'],
    'child-src': ['blob:'],
  };
};

/** Adds the aisstream WebSocket origin to `connect-src` when the Home map has an AIS key. */
export const withAisOrigin = (additions: CspAdditions, aisOrigin: string | null): CspAdditions =>
  aisOrigin
    ? { ...additions, 'connect-src': [...(additions['connect-src'] ?? []), aisOrigin] }
    : additions;
