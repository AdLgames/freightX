import { describe, expect, it } from 'vitest';
import { D } from '../src/money.js';
import { computeLineDuty, parseDutyExpression, resolveTariff } from '../src/tariff.js';
import type { RawTariffMeasure } from '../src/types.js';

const asOf = new Date('2026-09-10T00:00:00Z');
const m = (
  sid: string,
  measureTypeId: string,
  dutyExpression: string,
  geographicalAreaId = '1011',
  extra: Partial<RawTariffMeasure> = {},
): RawTariffMeasure => ({ sid, measureTypeId, dutyExpression, geographicalAreaId, ...extra });
const VAT20 = m('vat', '305', '20.00 %');

describe('parseDutyExpression', () => {
  it('parses ad valorem', () => {
    expect(parseDutyExpression('8.00 %')).toMatchObject({ ok: true, type: 'AD_VALOREM' });
    expect(parseDutyExpression('0.00 %')).toMatchObject({ ok: true, type: 'AD_VALOREM' });
  });
  it('parses specific per 100 kg, per kg, per tonne and per item', () => {
    const r = parseDutyExpression('£ 0.35 / 100 kg');
    expect(r).toMatchObject({ ok: true, type: 'SPECIFIC' });
    if (r.ok) expect(r.components[0]).toMatchObject({ kind: 'SPECIFIC', unit: 'kg' });
    expect(parseDutyExpression('£ 339.00 / 1000 kg')).toMatchObject({ ok: true, type: 'SPECIFIC' });
    expect(parseDutyExpression('0.17 GBP / kg')).toMatchObject({ ok: true, type: 'SPECIFIC' });
    expect(parseDutyExpression('£ 1.10 / p/st')).toMatchObject({ ok: true, type: 'SPECIFIC' });
  });
  it('parses compound', () => {
    const r = parseDutyExpression('12.80 % + £ 121.00 / 100 kg');
    expect(r).toMatchObject({ ok: true, type: 'COMPOUND' });
    if (r.ok) expect(r.components).toHaveLength(2);
  });
  it('rejects MAX/MIN, unknown units and empty expressions', () => {
    expect(parseDutyExpression('12.00 % MAX 24.00 %').ok).toBe(false);
    expect(parseDutyExpression('£ 2.67 / l alc. 100%').ok).toBe(false);
    expect(parseDutyExpression('').ok).toBe(false);
    expect(parseDutyExpression('free').ok).toBe(false);
  });
});

describe('resolveTariff — fail closed', () => {
  it('uses the third-country duty by default', () => {
    const r = resolveTariff([m('a', '103', '8.00 %'), VAT20], {
      originCountry: 'CN',
      preferenceClaimed: false,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tariff.dutyRatePct?.toString()).toBe('8');
      expect(r.tariff.vatRatePct.toString()).toBe('20');
      expect(r.tariff.measureId).toBe('a');
    }
  });
  it('fails when there is no 103 measure — never defaults to 0%', () => {
    const r = resolveTariff([VAT20], {
      originCountry: 'CN',
      preferenceClaimed: false,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok).toBe(false);
  });
  it('fails when several 103 measures disagree', () => {
    const r = resolveTariff(
      [m('a', '103', '8.00 %'), m('b', '103', '6.00 %', '1011', { additionalCode: '2500' }), VAT20],
      { originCountry: 'CN', preferenceClaimed: false, asOf, lineRef: 'x' },
    );
    expect(r.ok).toBe(false);
  });
  it('applies preference only when origin matches and it is claimed', () => {
    const measures = [m('tc', '103', '12.00 %'), m('pref', '142', '0.00 %', 'TR'), VAT20];
    const claimed = resolveTariff(measures, {
      originCountry: 'TR',
      preferenceClaimed: true,
      asOf,
      lineRef: 'x',
    });
    expect(claimed.ok && claimed.tariff.preferenceClaimed).toBe(true);
    expect(claimed.ok && claimed.tariff.dutyRatePct?.toString()).toBe('0');

    const unclaimed = resolveTariff(measures, {
      originCountry: 'TR',
      preferenceClaimed: false,
      asOf,
      lineRef: 'x',
    });
    expect(unclaimed.ok && unclaimed.tariff.dutyRatePct?.toString()).toBe('12');
    expect(unclaimed.warnings.toArray().map((w) => w.code)).toContain('PREFERENCE_AVAILABLE');

    const wrongOrigin = resolveTariff(measures, {
      originCountry: 'CN',
      preferenceClaimed: true,
      asOf,
      lineRef: 'x',
    });
    expect(wrongOrigin.ok && wrongOrigin.tariff.dutyRatePct?.toString()).toBe('12');
    expect(wrongOrigin.warnings.toArray().map((w) => w.code)).toContain('PREFERENCE_NOT_ELIGIBLE');
  });
  it('matches group membership for preferences', () => {
    const measures = [
      m('tc', '103', '12.00 %'),
      m('pref', '142', '0.00 %', '1013', { geographicalAreaMembers: ['DE', 'FR'] }),
      VAT20,
    ];
    const r = resolveTariff(measures, {
      originCountry: 'FR',
      preferenceClaimed: true,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok && r.tariff.preferenceClaimed).toBe(true);
    const r2 = resolveTariff(measures, {
      originCountry: 'CN',
      preferenceClaimed: true,
      asOf,
      lineRef: 'x',
    });
    expect(r2.ok && r2.tariff.preferenceClaimed).toBe(false);
  });
  it('respects excluded countries on group measures', () => {
    const measures = [
      m('tc', '103', '12.00 %'),
      m('pref', '142', '0.00 %', '2005', {
        geographicalAreaMembers: ['VN', 'KH'],
        excludedCountries: ['KH'],
      }),
      VAT20,
    ];
    const r = resolveTariff(measures, {
      originCountry: 'KH',
      preferenceClaimed: true,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok && r.tariff.preferenceClaimed).toBe(false);
    expect(r.warnings.toArray().map((w) => w.code)).toContain('PREFERENCE_NOT_ELIGIBLE');
  });
  it('adds anti-dumping duty, taking the highest of several exporter-specific rates', () => {
    const r = resolveTariff(
      [
        m('tc', '103', '6.50 %'),
        m('a1', '552', '48.50 %', 'CN', { additionalCode: 'C999' }),
        m('a2', '552', '30.60 %', 'CN', { additionalCode: 'C998' }),
        VAT20,
      ],
      { originCountry: 'CN', preferenceClaimed: false, asOf, lineRef: 'x' },
    );
    expect(r.ok && r.tariff.addRatePct?.toString()).toBe('48.5');
    const codes = r.warnings.toArray().map((w) => w.code);
    expect(codes).toContain('ADD_APPLIES');
    expect(codes).toContain('ADD_RATE_MAX_ASSUMED');
  });
  it('ignores anti-dumping duty for other origins', () => {
    const r = resolveTariff([m('tc', '103', '6.50 %'), m('a1', '552', '48.50 %', 'CN'), VAT20], {
      originCountry: 'VN',
      preferenceClaimed: false,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok && r.tariff.addRatePct).toBeNull();
  });
  it('fails on specific anti-dumping duty (unsupported in v1)', () => {
    const r = resolveTariff(
      [m('tc', '103', '6.50 %'), m('a1', '552', '£ 200.00 / 1000 kg', 'CN'), VAT20],
      { originCountry: 'CN', preferenceClaimed: false, asOf, lineRef: 'x' },
    );
    expect(r.ok).toBe(false);
  });
  it('assumes 20% VAT with a warning when no VAT measure exists', () => {
    const r = resolveTariff([m('tc', '103', '8.00 %')], {
      originCountry: 'CN',
      preferenceClaimed: false,
      asOf,
      lineRef: 'x',
    });
    expect(r.ok && r.tariff.vatRatePct.toString()).toBe('20');
    expect(r.warnings.toArray().map((w) => w.code)).toContain('VAT_ASSUMED_STANDARD');
  });
  it('takes the highest VAT rate when several exist', () => {
    const r = resolveTariff(
      [
        m('tc', '103', '8.00 %'),
        VAT20,
        m('vz', '305', '0.00 %', '1011', { additionalCode: 'VATZ' }),
      ],
      { originCountry: 'CN', preferenceClaimed: false, asOf, lineRef: 'x' },
    );
    expect(r.ok && r.tariff.vatRatePct.toString()).toBe('20');
    expect(r.warnings.toArray().map((w) => w.code)).toContain('VAT_RATE_MAX_ASSUMED');
  });
  it('flags quotas and excise', () => {
    const r = resolveTariff(
      [m('tc', '103', '8.00 %'), m('q', '122', '0.00 %'), m('e', '306', '£ 1.00 / l'), VAT20],
      { originCountry: 'CN', preferenceClaimed: false, asOf, lineRef: 'x' },
    );
    const codes = r.warnings.toArray().map((w) => w.code);
    expect(codes).toContain('QUOTA_APPLIES');
    expect(codes).toContain('EXCISE_APPLIES');
  });
  it('ignores measures outside their effective dates', () => {
    const r = resolveTariff(
      [
        m('old', '103', '8.00 %', '1011', { effectiveEndDate: '2020-01-01' }),
        m('new', '103', '10.00 %', '1011', { effectiveStartDate: '2021-01-01' }),
        VAT20,
      ],
      { originCountry: 'CN', preferenceClaimed: false, asOf, lineRef: 'x' },
    );
    expect(r.ok && r.tariff.measureId).toBe('new');
  });
});

describe('computeLineDuty', () => {
  it('handles ad valorem, specific (kg and item) and compound', () => {
    const line = { customsValueGbp: D('1000'), weightKg: D('250'), quantity: 40 };
    expect(computeLineDuty([{ kind: 'AD_VALOREM', pct: D('8') }], null, line).toString()).toBe(
      '80',
    );
    expect(
      computeLineDuty(
        [{ kind: 'SPECIFIC', amountGbp: D('121'), per: D('100'), unit: 'kg' }],
        null,
        line,
      ).toString(),
    ).toBe('302.5');
    expect(
      computeLineDuty(
        [{ kind: 'SPECIFIC', amountGbp: D('1.10'), per: D('1'), unit: 'item' }],
        null,
        line,
      ).toString(),
    ).toBe('44');
    expect(
      computeLineDuty(
        [
          { kind: 'AD_VALOREM', pct: D('12.8') },
          { kind: 'SPECIFIC', amountGbp: D('121'), per: D('100'), unit: 'kg' },
        ],
        D('10'),
        line,
      ).toString(),
    ).toBe('530.5');
  });
});
