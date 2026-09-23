import { readFileSync } from 'node:fs';
import { InMemoryTariffCache, UkTradeTariffClient, type FetchLike } from '@harbour/adapters';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAN_REMINDER, QuoteResult } from '../components/quote-result';
import { createAppServices, setAppForTests, type AppServices } from '../services/app.server';
import { loadEnv } from '../services/env.server';
import { createLogger } from '../services/logger.server';
import { adaptersFile } from '../services/paths.server';
import { InMemoryRateLimiter } from '../services/rate-limit.server';
import { action, loader, type CalculatorActionData } from './calculator';

const NOW = new Date('2026-09-23T10:00:00Z');
const logLines: Array<Record<string, unknown>> = [];

const fixtureFetch: FetchLike = async (url) => {
  const path = url.endsWith('/commodities/9503004100')
    ? adaptersFile('fixtures', 'tariff', 'commodity-9503004100.json')
    : null;
  const body: unknown = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const status = path ? 200 : 404;
  return {
    ok: status === 200,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
};

let app: AppServices;
let clockMs = NOW.getTime();

beforeAll(async () => {
  const base = await createAppServices({
    env: loadEnv({ NODE_ENV: 'test' }),
    logger: createLogger({
      level: 'debug',
      sink: (l) => logLines.push(JSON.parse(l) as Record<string, unknown>),
    }),
    now: () => NOW,
  });
  app = {
    ...base,
    tariff: new UkTradeTariffClient({
      fetch: fixtureFetch,
      cache: new InMemoryTariffCache(),
      now: () => NOW,
      sleep: async () => {},
    }),
    rateLimiter: new InMemoryRateLimiter(() => clockMs),
  };
  setAppForTests(app);
});

afterAll(() => setAppForTests(null));

const post = (fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const params = new URLSearchParams(fields);
  return new Request('http://localhost/calculator', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: params.toString(),
  });
};

const run = async (
  request: Request,
): Promise<{ status: number | undefined; data: CalculatorActionData }> => {
  const res = await action({ request, params: {}, context: {} } as never);
  return { status: res.init?.status ?? undefined, data: res.data };
};

const VALID = {
  lane: 'CNSHA:GBFXT:SEA_LCL',
  incoterm: 'FOB',
  hsCode: '9503004100',
  originCountry: 'CN',
  quantity: '500',
  unitPrice: '4.50',
  currency: 'USD',
  unitWeightKg: '0.8',
  unitVolumeCbm: '0.004',
};

describe('calculator loader', () => {
  it('lists rate-sheet lanes with human names and reports Turnstile off', async () => {
    const data = await loader();
    expect(data.lanes.length).toBeGreaterThan(0);
    expect(data.lanes.find((l) => l.key === 'CNSHA:GBFXT:SEA_LCL')?.label).toMatch(
      /Shanghai → Felixstowe/,
    );
    expect(data.lanes.find((l) => l.key === 'CNPVG:GBLHR:AIR')?.label).toMatch(
      /Shanghai Pudong → London Heathrow/,
    );
    expect(data.turnstileSiteKey).toBeNull();
    expect(data.currencies).toContain('GBP');
    expect(data.rateSheet.version).toBe('RATE_SHEET_V1');
    expect(data.dutyPaymentMethods.map((m) => m.value)).toEqual([
      'BROKER_DEFERMENT',
      'OWN_DAN',
      'CDS_CASH',
    ]);
    // No env defaults → no invented fee terms.
    expect(data.brokerDefaults).toEqual({ feePct: null, minimumGbp: null });
  });
});

describe('calculator action', () => {
  it('renders zod errors per field with a 400 and echoes the submitted values', async () => {
    const { status, data } = await run(
      post({ ...VALID, hsCode: '95030', quantity: '0', unitPrice: 'abc', lane: 'XX:YY:ZZ' }),
    );
    expect(status).toBe(400);
    expect(data.formError).toMatch(/highlighted fields/);
    expect(data.errors).toMatchObject({
      hsCode: 'HS code must be 6, 8 or 10 digits.',
      quantity: 'Quantity must be at least 1.',
      unitPrice: expect.stringMatching(/decimal places/) as string,
      lane: 'Choose a route from the list.',
    });
    expect(data.values.hsCode).toBe('95030');
    expect(data.outcome).toBeNull();
  });
  it('requires a volume or full carton details', async () => {
    const { unitVolumeCbm: _drop, ...noVolume } = VALID;
    const { status, data } = await run(post(noVolume));
    expect(status).toBe(400);
    expect(data.errors.unitVolumeCbm).toMatch(/volume per unit/i);
  });
  it('rejects a filled honeypot without running the pipeline', async () => {
    const { status, data } = await run(post({ ...VALID, website: 'http://spam' }));
    expect(status).toBe(400);
    expect(data.outcome).toBeNull();
    expect(logLines.some((l) => l.event === 'calculator.honeypot')).toBe(true);
  });
  it('rejects unreadable bodies', async () => {
    const { status } = await run(
      new Request('http://localhost/calculator', {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(status).toBe(400);
  });
  it('computes a READY quote and logs calculator.completed without PII', async () => {
    const { status, data } = await run(
      post(VALID, { 'x-forwarded-for': '198.51.100.7', 'x-request-id': 'req-quote-1' }),
    );
    expect(status).toBe(200);
    expect(data.formError).toBeNull();
    expect(data.outcome?.kind).toBe('QUOTE');
    expect(data.outcome?.quote.status).toBe('READY');
    expect(data.outcome?.quote.totals.totalLandedCost).toBe('2635.26');
    const completed = logLines.find(
      (l) => l.event === 'calculator.completed' && l.requestId === 'req-quote-1',
    );
    expect(completed).toMatchObject({
      status: 'READY',
      incoterm: 'FOB',
      mode: 'SEA_LCL',
      hsChapter: '95',
      currency: 'USD',
      quantity: 500,
    });
    const serialised = JSON.stringify(completed);
    expect(serialised).not.toContain('198.51.100.7');
    expect(serialised).not.toContain('@');
  });
  it('returns 429 with Retry-After once the hourly limit is hit, and recovers with time', async () => {
    const ip = { 'x-forwarded-for': '203.0.113.50' };
    let last: { status: number | undefined; data: CalculatorActionData } | undefined;
    for (let i = 0; i < 20; i += 1) {
      last = await run(post(VALID, ip));
      expect(last.status, `call ${i + 1}`).toBe(200);
    }
    const res = await action({ request: post(VALID, ip), params: {}, context: {} } as never);
    expect(res.init?.status).toBe(429);
    expect(new Headers(res.init?.headers).get('Retry-After')).toMatch(/^\d+$/);
    expect(res.data.formError).toMatch(/limit of 20 calculations/);
    clockMs += 60 * 60 * 1000;
    expect((await run(post(VALID, ip))).status).toBe(200);
  });
  it('turns an unknown tariff code into an INDICATIVE quote rather than an error', async () => {
    const { status, data } = await run(
      post({ ...VALID, hsCode: '6403999600' }, { 'x-forwarded-for': '203.0.113.51' }),
    );
    expect(status).toBe(200);
    expect(data.outcome?.quote.status).toBe('INDICATIVE');
    expect(data.outcome?.quote.warnings.map((w) => w.code)).toContain('TARIFF_AMBIGUOUS');
  });
});

describe('calculator action: assists, duty payment and PVA', () => {
  let ipSeq = 0;
  /** A fresh IP per call so these tests never share a rate-limit bucket. */
  const submit = (fields: Record<string, string>) => {
    ipSeq += 1;
    return run(post({ ...VALID, ...fields }, { 'x-forwarded-for': `192.0.2.${ipSeq}` }));
  };
  const html = (data: CalculatorActionData): string => {
    if (!data.outcome) throw new Error('no outcome to render');
    return renderToStaticMarkup(<QuoteResult outcome={data.outcome} calcVersion="1.1" />);
  };

  it('adds a £1,000 assist to the customs value, stays READY, and shows it', async () => {
    const { status, data } = await submit({ assistsGbp: '1000' });
    expect(status).toBe(200);
    const q = data.outcome?.quote;
    expect(q?.status).toBe('READY');
    expect(q?.totals.customsValue).toBe('2847.05'); // 1847.05 + 1000
    expect(q?.totals.assistsGbp).toBe('1000.00');
    const page = html(data);
    expect(page).toContain('Tooling, moulds and design (assists), included in customs value');
    expect(page).toContain('£1,000.00');
    expect(page).toContain('£2,847.05');
    expect(page).toContain('count towards the customs value'); // ASSISTS_INCLUDED, plain English
  });

  it('shows the helper computation (250 of 1,000 lifetime units → £250.00)', async () => {
    const { status, data } = await submit({
      quantity: '250',
      assistTotalCostGbp: '1000',
      assistTotalUnits: '1000',
    });
    expect(status).toBe(200);
    expect(data.outcome?.quote.totals.assistsGbp).toBe('250.00');
    expect(html(data)).toContain(
      '£1,000.00 total × 250 units in this shipment ÷ 1,000 units = £250.00',
    );
  });

  it('rejects an assist amount and the helper together', async () => {
    const { status, data } = await submit({
      assistsGbp: '250',
      assistTotalCostGbp: '1000',
      assistTotalUnits: '1000',
    });
    expect(status).toBe(400);
    expect(data.errors.assistsGbp).toMatch(/not both/);
    expect(data.outcome).toBeNull();
  });

  it('broker deferment with explicit terms: the fee appears in the totals and the page', async () => {
    const { data } = await submit({
      dutyPayment: 'BROKER_DEFERMENT',
      brokerFeePct: '2.5',
      brokerMinimumGbp: '25',
    });
    const t = data.outcome?.quote.totals;
    expect(t?.financingFee).toBe('25.00');
    expect(t?.borderOutlay).toBe('439.21');
    expect(t?.totalLandedCostExVat).toBe('2221.05');
    const page = html(data);
    expect(page).toContain(
      'Forwarder deferment fee (2.5% of duty and VAT advanced, minimum £25.00)',
    );
    expect(page).toContain('£25.00');
    expect(page).toContain('Cash needed at the border');
    expect(page).toContain('BROKER_DEFERMENT_FEE');
  });

  it('broker deferment without terms says fee terms depend on the forwarder', async () => {
    const { data } = await submit({});
    expect(data.outcome?.quote.totals.financingFee).toBe('0.00');
    expect(html(data)).toContain('fee terms depend on your forwarder');
  });

  it('PVA: cash at the border excludes VAT, with the explanation', async () => {
    const { data } = await submit({ vatRegistered: 'on', vatPostponed: 'on' });
    const t = data.outcome?.quote.totals;
    expect(t?.vatPostponed).toBe(true);
    expect(t?.borderOutlay).toBe('0.00');
    expect(t?.totalVat).toBe('439.21');
    expect(html(data)).toContain(
      'Import VAT £439.21 is accounted for on your VAT return, not paid at the border.',
    );
  });

  it('PVA without VAT registration shows the warning (fails visibly)', async () => {
    const { status, data } = await submit({ vatPostponed: 'on' });
    expect(status).toBe(200);
    expect(data.outcome?.quote.totals.vatPostponed).toBe(false);
    expect(data.outcome?.quote.totals.borderOutlay).toBe('439.21');
    const page = html(data);
    expect(page).toContain('PVA_REQUIRES_VAT_REGISTRATION');
    expect(page).toContain('Postponed VAT accounting is only open to VAT-registered businesses');
    expect(page).not.toContain('accounted for on your VAT return, not paid at the border');
  });

  it('own DAN: requires the authorisation, shows the CDS reminder, never logs or returns the DAN', async () => {
    const refused = await submit({ dutyPayment: 'OWN_DAN', dan: '7654321' });
    expect(refused.status).toBe(400);
    expect(refused.data.errors.danAuthorised).toMatch(/authorised your forwarder’s EORI/);

    const badDan = await submit({ dutyPayment: 'OWN_DAN', dan: '76543', danAuthorised: 'on' });
    expect(badDan.data.errors.dan).toMatch(/7 digits/);

    const { status, data } = await submit({
      dutyPayment: 'OWN_DAN',
      dan: '7654321',
      danAuthorised: 'on',
    });
    expect(status).toBe(200);
    expect(data.outcome?.dutyPayment).toEqual({
      method: 'OWN_DAN',
      brokerFeeTerms: null,
      danAuthorised: true,
    });
    expect(html(data)).toContain(DAN_REMINDER);
    expect(JSON.stringify(data.outcome)).not.toContain('7654321');
    expect(JSON.stringify(logLines)).not.toContain('7654321');
    expect(
      logLines.some((l) => l.event === 'calculator.completed' && l.dutyPayment === 'OWN_DAN'),
    ).toBe(true);
  });
});
