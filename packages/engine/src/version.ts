/**
 * Engine version stamped onto every quote (`Quote.calcVersion`).
 *
 * Bump on ANY formula change (§5.10). Old quotes keep the version that produced them.
 * Format: MAJOR.MINOR — MAJOR for changes that alter money outputs, MINOR for new
 * warnings / metadata that leave numbers unchanged.
 */
export const CALC_VERSION = '1.0';
