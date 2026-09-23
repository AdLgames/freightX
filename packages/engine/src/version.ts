/**
 * Engine version stamped onto every quote (`Quote.calcVersion`).
 *
 * Bump on ANY formula change (§5.10). Old quotes keep the version that produced them.
 * Format: MAJOR.MINOR — MAJOR for changes that alter money outputs, MINOR for new
 * warnings / metadata that leave numbers unchanged.
 */
// 1.1 (2026-09-23): assists, postponed VAT, broker deferment fee, inland VAT adjustment
// (ADR-0011). Existing inputs produce unchanged money outputs.
export const CALC_VERSION = '1.1';
