import type { ScheduleProvider, ScheduleResult, ScheduleSearch } from './types.js';

const LOCODE = /^[A-Z]{2}[A-Z0-9]{3}$/;

/**
 * Placeholder `ScheduleProvider` (ADR-0010). Reports NOT_CONFIGURED until an aggregator
 * (Portcast / Linescape / SeaRates / Freightify) or a DCSA carrier adapter is implemented.
 * It still validates the query so the UI path can be exercised end to end.
 */
export class NotConfiguredScheduleProvider implements ScheduleProvider {
  readonly name = 'NOT_CONFIGURED';

  async search(query: ScheduleSearch): Promise<ScheduleResult> {
    const invalid = validateScheduleSearch(query);
    if (invalid) return { ok: false, provider: this.name, reason: 'INVALID', message: invalid };
    return {
      ok: false,
      provider: this.name,
      reason: 'NOT_CONFIGURED',
      message:
        'No sailing-schedule provider is configured (decision (i) in docs/decisions-needed.md).',
    };
  }
}

export const validateScheduleSearch = (q: ScheduleSearch): string | null => {
  if (!LOCODE.test(q.origin) || !LOCODE.test(q.destination))
    return 'origin and destination must be UN/LOCODEs';
  if (q.origin === q.destination) return 'origin and destination must differ';
  if (Number.isNaN(new Date(q.earliestDeparture).getTime()))
    return 'earliestDeparture must be an ISO date';
  if (
    q.windowDays !== undefined &&
    (!Number.isInteger(q.windowDays) || q.windowDays < 1 || q.windowDays > 90)
  ) {
    return 'windowDays must be an integer between 1 and 90';
  }
  return null;
};
