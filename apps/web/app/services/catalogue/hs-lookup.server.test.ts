import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW as NOW, fixtureTariff } from '../../test-support/tariff-fixtures';
import { hsLookupStatus, lookupHsCode, summariseCommodity } from './hs-lookup.server';

describe('lookupHsCode', () => {
  it('10 digits: official description, third-country duty, VAT and the preference hint', async () => {
    const r = await lookupHsCode(fixtureTariff(), '9503.00.41.00', () => NOW);
    expect(r).toMatchObject({
      ok: true,
      kind: 'COMMODITY',
      code: '9503004100',
      description: "Tricycles, scooters, pedal cars and similar wheeled toys; dolls' carriages",
      thirdCountryDuty: '0.00 %',
      vatRate: '20.00 %',
      preferenceEligible: false,
      fromCache: false,
      fetchedAt: NOW.toISOString(),
    });
  });

  it('flags preference eligibility when a 142 measure exists for some origin', async () => {
    const r = await lookupHsCode(fixtureTariff(), '6403999600', () => NOW);
    expect(r).toMatchObject({ ok: true, kind: 'COMMODITY', preferenceEligible: true });
  });

  it('6 digits: lists the declarable 10-digit children, never picks one', async () => {
    const r = await lookupHsCode(fixtureTariff(), '950300', () => NOW);
    expect(r.ok && r.kind === 'CANDIDATES').toBe(true);
    if (!r.ok || r.kind !== 'CANDIDATES') return;
    expect(r.code).toBe('950300');
    expect(r.candidates.map((c) => c.code)).toEqual([
      '9503001000',
      '9503004100',
      '9503004900',
      '9503007000',
    ]);
    expect(r.candidates[1]).toEqual({
      code: '9503004100',
      description: 'Stuffed dolls representing only human beings',
      thirdCountryDuty: '0.00 %',
    });
  });

  it('8 digits with exactly one child is still a candidate for the user to confirm', async () => {
    const r = await lookupHsCode(fixtureTariff(), '95030041', () => NOW);
    expect(r).toMatchObject({ ok: true, kind: 'CANDIDATES', code: '95030041' });
    if (r.ok && r.kind === 'CANDIDATES')
      expect(r.candidates.map((c) => c.code)).toEqual(['9503004100']);
  });

  it.each(['950300410', '95030041001', '9503', 'ABCDEF', ''])('%j is INVALID', async (code) => {
    const r = await lookupHsCode(fixtureTariff(), code, () => NOW);
    expect(r).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(hsLookupStatus(r)).toBe(400);
  });

  it('NOT_FOUND for an unknown commodity or heading', async () => {
    expect(await lookupHsCode(fixtureTariff(), '9999999999', () => NOW)).toMatchObject({
      ok: false,
      reason: 'NOT_FOUND',
    });
    expect(await lookupHsCode(fixtureTariff(), '999999', () => NOW)).toMatchObject({
      ok: false,
      reason: 'NOT_FOUND',
    });
  });

  it('UNAVAILABLE when the tariff service cannot be reached (never a throw, never 0% assumed)', async () => {
    const r = await lookupHsCode(fixtureTariff(), '1701131000', () => NOW);
    expect(r).toMatchObject({ ok: false, reason: 'UNAVAILABLE' });
    expect(hsLookupStatus(r)).toBe(503);
    if (!r.ok) expect(r.message).toContain('save the product unverified');
  });
});

describe('summariseCommodity', () => {
  it('ignores measures outside their effective dates and non-ERGA-OMNES duties', () => {
    const s = summariseCommodity(
      {
        code: '0000000000',
        description: 'x',
        declarable: true,
        measures: [
          {
            sid: '1',
            measureTypeId: '103',
            dutyExpression: '5.00 %',
            geographicalAreaId: '1011',
            effectiveEndDate: '2020-01-01',
          },
          { sid: '2', measureTypeId: '103', dutyExpression: '7.00 %', geographicalAreaId: 'CN' },
          { sid: '3', measureTypeId: '142', dutyExpression: '0.00 %', geographicalAreaId: '1013' },
        ],
      },
      NOW,
    );
    expect(s).toEqual({
      code: '0000000000',
      description: 'x',
      thirdCountryDuty: null,
      vatRate: null,
      preferenceEligible: true,
    });
  });
});
