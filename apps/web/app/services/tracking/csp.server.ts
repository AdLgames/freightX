import type { CspAdditions } from '../security-headers.server';

/**
 * M9 (ADR-0017) — CSP additions for the map. MapLibre fetches the style, tiles, glyphs and
 * sprites from the style's origin (and any extra tile origins), runs its workers from blob:
 * URLs, and deck.gl's IconLayer loads the ship icon from an inline SVG data: URL. Nothing here
 * touches script-src. entry.server applies these to every response (the map is reached by
 * client-side navigation, so the document's policy must already allow it).
 *
 * A same-origin style (a path such as the built-in `/map-styles/harbour-blue.json`) reads its
 * tiles and glyphs from OpenFreeMap, so that origin is added for it.
 *
 * If a browser reports a `style-src` violation from the map, add `'style-src': ["'self'"]`
 * plus the offending source here rather than globally (see apps/web README, "Tracking (M9)").
 */
export const OPENFREEMAP_ORIGIN = 'https://tiles.openfreemap.org';

export const mapCspAdditions = (
  mapStyleUrl: string,
  extraOrigins: readonly string[] = [],
): CspAdditions => {
  let origin: string | null = null;
  if (mapStyleUrl.startsWith('/')) {
    origin = OPENFREEMAP_ORIGIN;
  } else {
    try {
      const u = new URL(mapStyleUrl);
      origin = u.protocol === 'https:' ? u.origin : null;
    } catch {
      origin = null;
    }
  }
  const hosts = [...new Set([origin, ...extraOrigins].filter((o): o is string => o !== null))];
  return {
    'connect-src': hosts,
    'img-src': [...hosts, 'data:', 'blob:'],
    'worker-src': ['blob:'],
    'child-src': ['blob:'],
  };
};
