import { ECB_DAILY_URL, InMemoryFxStore, hmrcMonthlyCsvUrl } from '@harbour/adapters';
import { describe, expect, it } from 'vitest';
import { formatYearMonth, nextYearMonth, runFxRefresh } from '../src/jobs/fx-refresh.js';
import { CollectingAlertSink } from '../src/ports.js';
import { fakeFetch, fxFixture, noSleep } from './helpers.js';

const HMRC_SEP = hmrcMonthlyCsvUrl(2026, 9);
const HMRC_OCT = hmrcMonthlyCsvUrl(2026, 10);
const hmrcCsv = fxFixture('hmrc-monthly-sample.csv');
const ecbXml = fxFixture('ecb-daily-sample.xml');

const setup = (routes: Parameters<typeof fakeFetch>[0], nowIso: string) => {
  const { fetch, calls } = fakeFetch(routes);
  const store = new InMemoryFxStore();
  const alerts = new CollectingAlertSink();
  const run = () =>
    runFxRefresh({ fetch, store, alerts, now: () => new Date(nowIso), sleep: noSleep });
  return { run, calls, store, alerts };
};

describe('runFxRefresh — happy path', () => {
  it('loads the current HMRC month and ECB fallback rates into the store', async () => {
    const { run, store, alerts, calls } = setup(
      {
        [HMRC_SEP]: { status: 200, body: hmrcCsv },
        [ECB_DAILY_URL]: { status: 200, body: ecbXml },
      },
      '2026-09-10T06:00:00Z',
    );
    const summary = await run();
    expect(summary).toEqual({
      hmrcMonthsLoaded: ['2026-09'],
      hmrcRecords: 5,
      ecbRecords: 4, // EUR + USD, CNY, INR (GBP itself is not a record)
      alerts: 0,
      errors: [],
    });
    expect(alerts.alerts).toEqual([]);
    expect(calls).toEqual([HMRC_SEP, ECB_DAILY_URL]);
    const at = new Date('2026-09-15T00:00:00Z');
    expect(await store.find('HMRC_MONTHLY', 'USD', at)).toMatchObject({ rateToGbp: '0.780031' });
    expect(await store.find('ECB', 'USD', new Date('2026-09-23T00:00:00Z'))).toMatchObject({
      rateToGbp: '0.735043',
    });
  });

  it('is idempotent: running twice does not duplicate rows', async () => {
    const { run, store } = setup(
      {
        [HMRC_SEP]: { status: 200, body: hmrcCsv },
        [ECB_DAILY_URL]: { status: 200, body: ecbXml },
      },
      '2026-09-10T06:00:00Z',
    );
    await run();
    await run();
    const rows = (store as unknown as { records: unknown[] }).records;
    expect(rows).toHaveLength(9);
  });
});

describe('runFxRefresh — next month publication window', () => {
  it('does not even ask for next month before the 25th', async () => {
    const { run, calls, alerts } = setup(
      {
        [HMRC_SEP]: { status: 200, body: hmrcCsv },
        [ECB_DAILY_URL]: { status: 200, body: ecbXml },
      },
      '2026-09-24T06:00:00Z',
    );
    await run();
    expect(calls).not.toContain(HMRC_OCT);
    expect(alerts.alerts).toEqual([]);
  });

  it('from the 25th tries next month; a 404 before publication is not an alert', async () => {
    const { run, calls, alerts } = setup(
      {
        [HMRC_SEP]: { status: 200, body: hmrcCsv },
        [ECB_DAILY_URL]: { status: 200, body: ecbXml },
      },
      '2026-09-25T07:00:00Z',
    );
    const summary = await run();
    expect(calls).toContain(HMRC_OCT);
    expect(summary.hmrcMonthsLoaded).toEqual(['2026-09']);
    expect(summary.alerts).toBe(0);
    expect(alerts.alerts).toEqual([]);
    expect(summary.errors).toEqual(['HMRC 2026-10: not published (404), expected']);
  });

  it('loads next month too once it is published', async () => {
    const octCsv = hmrcCsv.replaceAll('/09/2026', '/10/2026');
    const { run, summary } = await (async () => {
      const s = setup(
        {
          [HMRC_SEP]: { status: 200, body: hmrcCsv },
          [HMRC_OCT]: { status: 200, body: octCsv },
          [ECB_DAILY_URL]: { status: 200, body: ecbXml },
        },
        '2026-09-26T06:00:00Z',
      );
      return { ...s, summary: await s.run() };
    })();
    expect(run).toBeTypeOf('function');
    expect(summary.hmrcMonthsLoaded).toEqual(['2026-09', '2026-10']);
    expect(summary.hmrcRecords).toBe(10);
  });

  it('rolls December over to January of the next year', () => {
    expect(formatYearMonth(nextYearMonth({ year: 2026, month: 12 }))).toBe('2027-01');
  });
});

describe('runFxRefresh — HMRC missing by the 2nd (§5.7)', () => {
  it('raises critical FX_HMRC_MISSING on the 2nd when the month is still absent', async () => {
    const { run, alerts, summary } = await (async () => {
      const s = setup({ [ECB_DAILY_URL]: { status: 200, body: ecbXml } }, '2026-10-02T06:00:00Z');
      return { ...s, summary: await s.run() };
    })();
    expect(run).toBeTypeOf('function');
    expect(summary.hmrcMonthsLoaded).toEqual([]);
    expect(summary.alerts).toBe(1);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({
      level: 'critical',
      code: 'FX_HMRC_MISSING',
      meta: { month: '2026-10', day: 2 },
    });
    // ECB fallback data was still refreshed.
    expect(summary.ecbRecords).toBe(4);
  });

  it('does not alert on the 1st (publication may still be pending)', async () => {
    const { run, alerts } = setup(
      { [ECB_DAILY_URL]: { status: 200, body: ecbXml } },
      '2026-10-01T07:00:00Z',
    );
    await run();
    expect(alerts.alerts).toEqual([]);
  });

  it("does not alert when the month was loaded on an earlier run and today's fetch fails", async () => {
    const { fetch } = fakeFetch({ [ECB_DAILY_URL]: { status: 200, body: ecbXml } });
    const store = new InMemoryFxStore();
    await store.upsert([
      {
        source: 'HMRC_MONTHLY',
        currency: 'USD',
        rateToGbp: '0.78',
        validFrom: '2026-10-01',
        validTo: '2026-10-31',
      },
    ]);
    const alerts = new CollectingAlertSink();
    const summary = await runFxRefresh({
      fetch,
      store,
      alerts,
      now: () => new Date('2026-10-05T06:00:00Z'),
      sleep: noSleep,
    });
    expect(summary.hmrcMonthsLoaded).toEqual([]);
    expect(alerts.alerts).toEqual([]);
  });
});

describe('runFxRefresh — provider failures never throw', () => {
  it('ECB failure yields a warning but HMRC data is still stored', async () => {
    const { run, store, alerts, summary } = await (async () => {
      const s = setup(
        {
          [HMRC_SEP]: { status: 200, body: hmrcCsv },
          [ECB_DAILY_URL]: { status: 503, body: 'down' },
        },
        '2026-09-10T06:00:00Z',
      );
      return { ...s, summary: await s.run() };
    })();
    expect(run).toBeTypeOf('function');
    expect(summary.hmrcMonthsLoaded).toEqual(['2026-09']);
    expect(summary.ecbRecords).toBe(0);
    expect(summary.alerts).toBe(1);
    expect(alerts.alerts[0]).toMatchObject({ level: 'warning', code: 'FX_ECB_FETCH_FAILED' });
    expect(
      await store.find('HMRC_MONTHLY', 'USD', new Date('2026-09-15T00:00:00Z')),
    ).not.toBeNull();
  });

  it('retries a 5xx from HMRC (2 retries) then reports FX_HMRC_FETCH_FAILED', async () => {
    const { run, calls, alerts, summary } = await (async () => {
      const s = setup(
        {
          [HMRC_SEP]: { status: 500, body: 'boom' },
          [ECB_DAILY_URL]: { status: 200, body: ecbXml },
        },
        '2026-09-10T06:00:00Z',
      );
      return { ...s, summary: await s.run() };
    })();
    expect(run).toBeTypeOf('function');
    expect(calls.filter((u) => u === HMRC_SEP)).toHaveLength(3);
    // Day 10 with nothing in the store: the fetch failure is also a "month missing" condition.
    expect(alerts.alerts.map((a) => a.code)).toEqual(['FX_HMRC_FETCH_FAILED', 'FX_HMRC_MISSING']);
    expect(summary.ecbRecords).toBe(4);
  });

  it('a network error on both providers is reported, not thrown', async () => {
    const { run, alerts, summary } = await (async () => {
      const s = setup(
        { [HMRC_SEP]: new Error('ECONNRESET'), [ECB_DAILY_URL]: new Error('ECONNRESET') },
        '2026-09-10T06:00:00Z',
      );
      return { ...s, summary: await s.run() };
    })();
    expect(run).toBeTypeOf('function');
    expect(summary.alerts).toBe(3);
    expect(alerts.alerts.map((a) => a.code).sort()).toEqual([
      'FX_ECB_FETCH_FAILED',
      'FX_HMRC_FETCH_FAILED',
      'FX_HMRC_MISSING',
    ]);
  });

  it('an unrecognised HMRC format is a parse alert (format change = code change)', async () => {
    const { run, alerts } = setup(
      {
        [HMRC_SEP]: { status: 200, body: 'a,b,c\n1,2,3\n' },
        [ECB_DAILY_URL]: { status: 200, body: ecbXml },
      },
      '2026-09-10T06:00:00Z',
    );
    await run();
    expect(alerts.alerts.map((a) => a.code)).toEqual(['FX_HMRC_PARSE_FAILED', 'FX_HMRC_MISSING']);
  });
});
