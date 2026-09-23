import type { Sailing } from './types.js';

/**
 * Advisory signals derived from a sailing (ADR-0010). They never affect quote money or
 * `calcVersion`. In Phase 2, `CUTOFF_PASSED` and a confirmed blank sailing become booking
 * preconditions; until then they are display-only.
 */
export type ScheduleSignalCode =
  | 'BLANK_SAILING_RISK'
  | 'CUTOFF_PASSED'
  | 'CUTOFF_IMMINENT'
  | 'TRANSSHIPMENT'
  | 'PORT_CONGESTION'
  | 'CUTOFFS_UNKNOWN';

export interface ScheduleSignal {
  code: ScheduleSignalCode;
  message: string;
  /** True when the sailing should not be offered for "Request space". */
  blocksRequest: boolean;
}

export interface SignalOptions {
  /** Hours before a cut-off at which CUTOFF_IMMINENT fires. Default 48. */
  imminentHours?: number;
  /** Congestion index at or above which PORT_CONGESTION fires. Default 70. */
  congestionThreshold?: number;
}

const HOUR_MS = 60 * 60 * 1000;

export const deriveScheduleSignals = (
  sailing: Sailing,
  now: Date,
  opts: SignalOptions = {},
): ScheduleSignal[] => {
  const imminentMs = (opts.imminentHours ?? 48) * HOUR_MS;
  const congestionThreshold = opts.congestionThreshold ?? 70;
  const signals: ScheduleSignal[] = [];
  const nowMs = now.getTime();

  const cutoffs: Array<[string, string | null]> = [
    ['cargo', sailing.cutoffs.cargo],
    ['VGM', sailing.cutoffs.vgm],
    ['documentation', sailing.cutoffs.documentation],
  ];
  const known = cutoffs.filter((c): c is [string, string] => c[1] !== null);
  if (known.length === 0) {
    signals.push({
      code: 'CUTOFFS_UNKNOWN',
      message:
        'The provider reports no cut-off times for this sailing; confirm them with the forwarder.',
      blocksRequest: false,
    });
  }
  let passed = false;
  let imminent = false;
  for (const [label, iso] of known) {
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    if (t <= nowMs) {
      passed = true;
      signals.push({
        code: 'CUTOFF_PASSED',
        message: `The ${label} cut-off has passed.`,
        blocksRequest: true,
      });
    } else if (t - nowMs <= imminentMs) {
      imminent = true;
    }
  }
  if (imminent && !passed) {
    signals.push({
      code: 'CUTOFF_IMMINENT',
      message: `A cut-off falls within ${opts.imminentHours ?? 48} hours; cargo and documents must already be moving.`,
      blocksRequest: false,
    });
  }
  if (sailing.blankSailing === true) {
    signals.push({
      code: 'BLANK_SAILING_RISK',
      message: 'The carrier has cancelled or is likely to cancel this sailing (blank sailing).',
      blocksRequest: true,
    });
  }
  if (sailing.legs.length > 1) {
    const via = sailing.legs
      .slice(0, -1)
      .map((l) => l.to)
      .join(', ');
    signals.push({
      code: 'TRANSSHIPMENT',
      message: `Transshipment via ${via}; transit ${sailing.transitDays} days.`,
      blocksRequest: false,
    });
  }
  if (
    sailing.originCongestionIndex !== null &&
    sailing.originCongestionIndex >= congestionThreshold
  ) {
    signals.push({
      code: 'PORT_CONGESTION',
      message: `Origin port congestion index ${sailing.originCongestionIndex}; expect delays to cut-offs and departure.`,
      blocksRequest: false,
    });
  }
  return signals;
};

/** Dedupe by (code) keeping the first message; CUTOFF_PASSED may legitimately repeat per cut-off. */
export const requestSpaceAllowed = (signals: readonly ScheduleSignal[]): boolean =>
  !signals.some((s) => s.blocksRequest);
