import { describe, expect, it } from 'vitest';
import {
  NotConfiguredScheduleProvider,
  deriveScheduleSignals,
  requestSpaceAllowed,
  validateScheduleSearch,
} from '../src/index.js';
import type { Sailing } from '../src/index.js';

const now = new Date('2026-10-01T12:00:00Z');
const sailing = (over: Partial<Sailing> = {}): Sailing => ({
  id: 'x',
  provider: 'TEST',
  carrier: 'MSCU',
  service: 'Albatross',
  origin: 'CNSZX',
  destination: 'GBFXT',
  etd: '2026-10-08T00:00:00Z',
  eta: '2026-11-05T00:00:00Z',
  transitDays: 28,
  legs: [
    {
      from: 'CNSZX',
      to: 'GBFXT',
      vesselName: 'MSC TEST',
      vesselImo: null,
      voyageNumber: '441W',
      etd: '2026-10-08T00:00:00Z',
      eta: '2026-11-05T00:00:00Z',
    },
  ],
  cutoffs: {
    cargo: '2026-10-06T12:00:00Z',
    vgm: '2026-10-06T12:00:00Z',
    documentation: '2026-10-05T12:00:00Z',
  },
  blankSailing: false,
  originCongestionIndex: 20,
  fetchedAt: '2026-10-01T00:00:00Z',
  ...over,
});

describe('deriveScheduleSignals (ADR-0010)', () => {
  it('is quiet for a clean direct sailing with future cut-offs', () => {
    const s = deriveScheduleSignals(sailing(), now);
    expect(s).toEqual([]);
    expect(requestSpaceAllowed(s)).toBe(true);
  });
  it('blocks a request when a cut-off has passed or the sailing is blank', () => {
    const passed = deriveScheduleSignals(
      sailing({ cutoffs: { cargo: '2026-10-01T11:00:00Z', vgm: null, documentation: null } }),
      now,
    );
    expect(passed.map((x) => x.code)).toEqual(['CUTOFF_PASSED']);
    expect(requestSpaceAllowed(passed)).toBe(false);
    const blank = deriveScheduleSignals(sailing({ blankSailing: true }), now);
    expect(blank.map((x) => x.code)).toEqual(['BLANK_SAILING_RISK']);
    expect(requestSpaceAllowed(blank)).toBe(false);
  });
  it('warns on imminent cut-offs, transshipment and congestion without blocking', () => {
    const s = deriveScheduleSignals(
      sailing({
        cutoffs: { cargo: '2026-10-02T12:00:00Z', vgm: null, documentation: null },
        legs: [
          {
            from: 'CNSZX',
            to: 'SGSIN',
            vesselName: null,
            vesselImo: null,
            voyageNumber: null,
            etd: '2026-10-08T00:00:00Z',
            eta: '2026-10-14T00:00:00Z',
          },
          {
            from: 'SGSIN',
            to: 'GBFXT',
            vesselName: null,
            vesselImo: null,
            voyageNumber: null,
            etd: '2026-10-16T00:00:00Z',
            eta: '2026-11-19T00:00:00Z',
          },
        ],
        transitDays: 42,
        originCongestionIndex: 85,
      }),
      now,
    );
    expect(s.map((x) => x.code)).toEqual(['CUTOFF_IMMINENT', 'TRANSSHIPMENT', 'PORT_CONGESTION']);
    expect(s.find((x) => x.code === 'TRANSSHIPMENT')?.message).toContain('SGSIN');
    expect(requestSpaceAllowed(s)).toBe(true);
  });
  it('never treats missing provider data as safe', () => {
    const s = deriveScheduleSignals(
      sailing({
        cutoffs: { cargo: null, vgm: null, documentation: null },
        blankSailing: null,
        originCongestionIndex: null,
      }),
      now,
    );
    expect(s.map((x) => x.code)).toEqual(['CUTOFFS_UNKNOWN']);
  });
});

describe('NotConfiguredScheduleProvider', () => {
  const p = new NotConfiguredScheduleProvider();
  it('validates the query, then reports NOT_CONFIGURED', async () => {
    expect(
      await p.search({
        origin: 'CNSZX',
        destination: 'GBFXT',
        mode: 'SEA_FCL',
        earliestDeparture: '2026-10-01',
      }),
    ).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(
      await p.search({
        origin: 'shenzhen',
        destination: 'GBFXT',
        mode: 'SEA_FCL',
        earliestDeparture: '2026-10-01',
      }),
    ).toMatchObject({ ok: false, reason: 'INVALID' });
  });
  it('validateScheduleSearch covers each rule', () => {
    expect(
      validateScheduleSearch({
        origin: 'CNSZX',
        destination: 'CNSZX',
        mode: 'SEA_LCL',
        earliestDeparture: '2026-10-01',
      }),
    ).toMatch(/differ/);
    expect(
      validateScheduleSearch({
        origin: 'CNSZX',
        destination: 'GBFXT',
        mode: 'SEA_LCL',
        earliestDeparture: 'soon',
      }),
    ).toMatch(/ISO/);
    expect(
      validateScheduleSearch({
        origin: 'CNSZX',
        destination: 'GBFXT',
        mode: 'SEA_LCL',
        earliestDeparture: '2026-10-01',
        windowDays: 120,
      }),
    ).toMatch(/90/);
    expect(
      validateScheduleSearch({
        origin: 'CNSZX',
        destination: 'GBFXT',
        mode: 'SEA_LCL',
        earliestDeparture: '2026-10-01',
        windowDays: 30,
      }),
    ).toBeNull();
  });
});
