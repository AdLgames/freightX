import { D, Decimal, ZERO } from './money.js';
import type { DutyType, RawTariffMeasure, SpecificDuty } from './types.js';
import { WarningBag } from './warnings.js';

/** ERGA OMNES — "all countries" geographical area in the UK tariff. */
export const ERGA_OMNES = '1011';

export const MEASURE_TYPES = {
  THIRD_COUNTRY_DUTY: '103',
  NON_PREF_QUOTA: '122',
  NON_PREF_QUOTA_END_USE: '123',
  PREFERENCE: '142',
  PREF_QUOTA: '143',
  VAT: '305',
  EXCISE: '306',
  ADD_PROVISIONAL: '551',
  ADD_DEFINITIVE: '552',
  CVD_PROVISIONAL: '553',
  CVD_DEFINITIVE: '554',
} as const;

const ADD_TYPES: ReadonlySet<string> = new Set(['551', '552', '553', '554']);
const QUOTA_TYPES: ReadonlySet<string> = new Set(['122', '123', '143']);

// ---------- Duty expression parsing ----------

export interface AdValoremComponent {
  kind: 'AD_VALOREM';
  pct: Decimal;
}
export interface SpecificComponent {
  kind: 'SPECIFIC';
  amountGbp: Decimal;
  per: Decimal;
  unit: 'kg' | 'item';
}
export type DutyComponent = AdValoremComponent | SpecificComponent;

export type ParsedDuty =
  { ok: true; type: DutyType; components: DutyComponent[] } | { ok: false; reason: string };

/**
 * Unit conversion table for specific duties. Keys are the unit text as it appears after the
 * slash in a UK tariff duty expression. Anything not listed is unsupported → TARIFF_AMBIGUOUS.
 */
const UNIT_TABLE: Readonly<Record<string, { per: string; unit: 'kg' | 'item' }>> = {
  kg: { per: '1', unit: 'kg' },
  '100 kg': { per: '100', unit: 'kg' },
  '1000 kg': { per: '1000', unit: 'kg' },
  tonne: { per: '1000', unit: 'kg' },
  'p/st': { per: '1', unit: 'item' },
  '100 p/st': { per: '100', unit: 'item' },
  '1000 p/st': { per: '1000', unit: 'item' },
};

const AD_VALOREM_RE = /^(\d+(?:\.\d+)?)\s*%$/;
const SPECIFIC_RE = /^(?:£\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*GBP)\s*\/\s*(.+)$/;

/**
 * Parse a UK tariff duty expression base string into components.
 * Handles ad valorem ("8.00 %"), specific ("£ 0.35 / 100 kg"), and compound
 * ("12.00 % + £ 25.00 / 100 kg"). MAX/MIN clauses and unknown units are rejected.
 */
export const parseDutyExpression = (expression: string): ParsedDuty => {
  const text = expression.replace(/\s+/g, ' ').trim();
  if (text === '') return { ok: false, reason: 'empty duty expression' };
  if (/\b(MAX|MIN)\b/i.test(text)) {
    return { ok: false, reason: `MAX/MIN duty expressions are not supported: "${expression}"` };
  }
  const parts = text.split(/\s\+\s|\+/).map((p) => p.trim());
  const components: DutyComponent[] = [];
  for (const part of parts) {
    const av = AD_VALOREM_RE.exec(part);
    if (av?.[1] !== undefined) {
      components.push({ kind: 'AD_VALOREM', pct: D(av[1]) });
      continue;
    }
    const sp = SPECIFIC_RE.exec(part);
    if (sp) {
      const amountText = sp[1] ?? sp[2];
      const unitText = sp[3]?.trim() ?? '';
      const unit = UNIT_TABLE[unitText];
      if (amountText === undefined || unit === undefined) {
        return { ok: false, reason: `unsupported specific duty unit: "${unitText}"` };
      }
      components.push({
        kind: 'SPECIFIC',
        amountGbp: D(amountText),
        per: D(unit.per),
        unit: unit.unit,
      });
      continue;
    }
    return { ok: false, reason: `unrecognised duty expression component: "${part}"` };
  }
  const hasAv = components.some((c) => c.kind === 'AD_VALOREM');
  const hasSp = components.some((c) => c.kind === 'SPECIFIC');
  const type: DutyType = hasAv && hasSp ? 'COMPOUND' : hasSp ? 'SPECIFIC' : 'AD_VALOREM';
  return { ok: true, type, components };
};

// ---------- Measure resolution ----------

export interface ResolvedTariff {
  measureId: string | null;
  dutyType: DutyType;
  dutyRatePct: Decimal | null;
  dutySpecific: SpecificDuty | null;
  components: DutyComponent[];
  preferenceClaimed: boolean;
  addRatePct: Decimal | null;
  vatRatePct: Decimal;
}

export type TariffResolution =
  | { ok: true; tariff: ResolvedTariff; warnings: WarningBag }
  | { ok: false; reason: string; warnings: WarningBag };

const geoMatches = (m: RawTariffMeasure, origin: string): boolean => {
  if (m.excludedCountries?.includes(origin)) return false;
  if (m.geographicalAreaId === ERGA_OMNES) return true;
  if (m.geographicalAreaId === origin) return true;
  return m.geographicalAreaMembers?.includes(origin) ?? false;
};

const isActive = (m: RawTariffMeasure, asOf: Date): boolean => {
  if (m.effectiveStartDate) {
    const start = new Date(m.effectiveStartDate);
    if (!Number.isNaN(start.getTime()) && start > asOf) return false;
  }
  if (m.effectiveEndDate) {
    const end = new Date(m.effectiveEndDate);
    if (!Number.isNaN(end.getTime()) && end < asOf) return false;
  }
  return true;
};

const distinctExpressions = (ms: readonly RawTariffMeasure[]): string[] => [
  ...new Set(ms.map((m) => m.dutyExpression.replace(/\s+/g, ' ').trim())),
];

const toSpecific = (components: DutyComponent[]): SpecificDuty | null => {
  const sp = components.find((c): c is SpecificComponent => c.kind === 'SPECIFIC');
  if (!sp) return null;
  return { amountGbp: sp.amountGbp.toString(), per: sp.per.toString(), unit: sp.unit };
};

const toAdValorem = (components: DutyComponent[]): Decimal | null => {
  const av = components.find((c): c is AdValoremComponent => c.kind === 'AD_VALOREM');
  return av ? av.pct : null;
};

/**
 * Pick the duty, ADD and VAT that apply to a (commodity, origin) from the measures the
 * adapter returned. Fail closed: anything unrecognisable is TARIFF_AMBIGUOUS, never 0%.
 */
export const resolveTariff = (
  measures: readonly RawTariffMeasure[],
  opts: { originCountry: string; preferenceClaimed: boolean; asOf: Date; lineRef: string },
): TariffResolution => {
  const warnings = new WarningBag();
  const { originCountry, lineRef } = opts;
  const applicable = measures.filter((m) => geoMatches(m, originCountry) && isActive(m, opts.asOf));

  // --- Third-country duty (default) ---
  const thirdCountry = applicable.filter(
    (m) => m.measureTypeId === MEASURE_TYPES.THIRD_COUNTRY_DUTY,
  );
  if (thirdCountry.length === 0) {
    return { ok: false, reason: 'no third-country duty measure (103) found', warnings };
  }
  const tcExpressions = distinctExpressions(thirdCountry);
  const tcFirst = thirdCountry[0];
  if (tcExpressions.length > 1 || tcFirst === undefined) {
    return {
      ok: false,
      reason: `multiple third-country duty measures with different rates: ${tcExpressions.join(' | ')}`,
      warnings,
    };
  }
  const tcParsed = parseDutyExpression(tcFirst.dutyExpression);
  if (!tcParsed.ok)
    return { ok: false, reason: `third-country duty: ${tcParsed.reason}`, warnings };

  let chosen: { measure: RawTariffMeasure; parsed: Extract<ParsedDuty, { ok: true }> } = {
    measure: tcFirst,
    parsed: tcParsed,
  };
  let preferenceClaimed = false;

  // --- Preference (142) — only if origin matches AND user claims it ---
  const prefs = applicable.filter(
    (m) => m.measureTypeId === MEASURE_TYPES.PREFERENCE && m.geographicalAreaId !== ERGA_OMNES,
  );
  if (prefs.length > 0) {
    const prefExpressions = distinctExpressions(prefs);
    const prefFirst = prefs[0];
    if (prefExpressions.length > 1 || prefFirst === undefined) {
      warnings.add(
        'PREFERENCE_AMBIGUOUS',
        `Several preferential rates apply for origin ${originCountry} (${prefExpressions.join(' | ')}); third-country rate used.`,
        lineRef,
      );
    } else if (!opts.preferenceClaimed) {
      warnings.add(
        'PREFERENCE_AVAILABLE',
        `A preferential rate (${prefExpressions[0] ?? ''}) may apply for origin ${originCountry} if proof of origin is held; third-country rate used.`,
        lineRef,
      );
    } else {
      const parsed = parseDutyExpression(prefFirst.dutyExpression);
      if (!parsed.ok) {
        return { ok: false, reason: `preferential duty: ${parsed.reason}`, warnings };
      }
      chosen = { measure: prefFirst, parsed };
      preferenceClaimed = true;
    }
  } else if (opts.preferenceClaimed) {
    warnings.add(
      'PREFERENCE_NOT_ELIGIBLE',
      `Preference claimed but no preferential measure exists for origin ${originCountry}; third-country rate used.`,
      lineRef,
    );
  }

  // --- Anti-dumping / countervailing (551-554) ---
  let addRatePct: Decimal | null = null;
  const adds = applicable.filter((m) => ADD_TYPES.has(m.measureTypeId));
  if (adds.length > 0) {
    const rates: Decimal[] = [];
    for (const m of adds) {
      const parsed = parseDutyExpression(m.dutyExpression);
      if (!parsed.ok || parsed.type !== 'AD_VALOREM') {
        return {
          ok: false,
          reason: `anti-dumping/countervailing duty is not a simple ad valorem rate ("${m.dutyExpression}"); not supported in v1`,
          warnings,
        };
      }
      const pct = toAdValorem(parsed.components);
      if (pct) rates.push(pct);
    }
    const distinct = [...new Set(rates.map((r) => r.toString()))];
    addRatePct = rates.reduce<Decimal>((acc, r) => (r.gt(acc) ? r : acc), ZERO);
    warnings.add(
      'ADD_APPLIES',
      `Anti-dumping / countervailing duty of ${addRatePct.toString()}% applies for origin ${originCountry}.`,
      lineRef,
    );
    if (distinct.length > 1) {
      warnings.add(
        'ADD_RATE_MAX_ASSUMED',
        `Several ADD/CVD rates exist (exporter-specific additional codes: ${distinct.join('%, ')}%); the highest was applied.`,
        lineRef,
      );
    }
  }

  // --- VAT (305) ---
  let vatRatePct: Decimal;
  const vats = applicable.filter((m) => m.measureTypeId === MEASURE_TYPES.VAT);
  if (vats.length === 0) {
    vatRatePct = D('20');
    warnings.add(
      'VAT_ASSUMED_STANDARD',
      'No VAT measure found on the commodity; standard rate 20% assumed.',
      lineRef,
    );
  } else {
    const rates: Decimal[] = [];
    for (const m of vats) {
      const parsed = parseDutyExpression(m.dutyExpression);
      if (!parsed.ok || parsed.type !== 'AD_VALOREM') {
        return { ok: false, reason: `VAT measure unparseable ("${m.dutyExpression}")`, warnings };
      }
      const pct = toAdValorem(parsed.components);
      if (pct) rates.push(pct);
    }
    const distinct = [...new Set(rates.map((r) => r.toString()))];
    vatRatePct = rates.reduce<Decimal>((acc, r) => (r.gt(acc) ? r : acc), ZERO);
    if (distinct.length > 1) {
      warnings.add(
        'VAT_RATE_MAX_ASSUMED',
        `Several VAT rates exist for this commodity (${distinct.join('%, ')}%); the highest was applied.`,
        lineRef,
      );
    }
  }

  // --- Quotas / excise: informational ---
  if (applicable.some((m) => QUOTA_TYPES.has(m.measureTypeId))) {
    warnings.add(
      'QUOTA_APPLIES',
      'A tariff quota exists for this commodity/origin; quota balances are not modelled — full rate assumed.',
      lineRef,
    );
  }
  if (applicable.some((m) => m.measureTypeId === MEASURE_TYPES.EXCISE)) {
    warnings.add(
      'EXCISE_APPLIES',
      'Excise duty applies to this commodity and is NOT included.',
      lineRef,
    );
  }

  const dutySpecific = toSpecific(chosen.parsed.components);
  if (dutySpecific) {
    warnings.add(
      'SPECIFIC_DUTY_WEIGHT_BASIS',
      'Specific duty computed on product weight as entered; HMRC assesses on net weight — confirm the weight basis.',
      lineRef,
    );
  }

  return {
    ok: true,
    warnings,
    tariff: {
      measureId: chosen.measure.sid,
      dutyType: chosen.parsed.type,
      dutyRatePct: toAdValorem(chosen.parsed.components),
      dutySpecific,
      components: chosen.parsed.components,
      preferenceClaimed,
      addRatePct,
      vatRatePct,
    },
  };
};

/** Duty for one line given its customs value, weight and quantity. Returns unrounded Decimal. */
export const computeLineDuty = (
  components: readonly DutyComponent[],
  addRatePct: Decimal | null,
  line: { customsValueGbp: Decimal; weightKg: Decimal; quantity: number },
): Decimal => {
  let duty = ZERO;
  for (const c of components) {
    if (c.kind === 'AD_VALOREM') {
      duty = duty.plus(line.customsValueGbp.times(c.pct).div(100));
    } else {
      const base = c.unit === 'kg' ? line.weightKg : new Decimal(line.quantity);
      duty = duty.plus(c.amountGbp.times(base).div(c.per));
    }
  }
  if (addRatePct) duty = duty.plus(line.customsValueGbp.times(addRatePct).div(100));
  return duty;
};
