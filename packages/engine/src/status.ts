import type { ComputedStatus } from './types.js';
import type { QuoteWarning } from './warnings.js';

/** §5.9: any blocking warning → INDICATIVE, otherwise READY. */
export const deriveStatus = (warnings: readonly QuoteWarning[]): ComputedStatus =>
  warnings.some((w) => w.blocking) ? 'INDICATIVE' : 'READY';
