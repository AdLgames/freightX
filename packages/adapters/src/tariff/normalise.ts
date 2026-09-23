import type { HsCandidate, RawTariffMeasure } from '@harbour/engine';
import {
  commodityResponseSchema,
  headingResponseSchema,
  type CommodityResponse,
  type HeadingResponse,
} from './schema.js';

export interface NormalisedCommodity {
  code: string;
  description: string;
  declarable: boolean;
  measures: RawTariffMeasure[];
}

const stripHtml = (s: string): string =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Convert a validated commodity response into the engine's `RawTariffMeasure[]`.
 * Only import measures are kept. Geographical-area group membership is resolved from the
 * `included` geographical areas' `children_geographical_areas` so the engine can match a
 * preference for e.g. "1013" (EU) against origin "DE".
 */
export const normaliseCommodity = (raw: unknown): NormalisedCommodity => {
  const parsed: CommodityResponse = commodityResponseSchema.parse(raw);
  const dutyExpressions = new Map<string, string>();
  const geoMembers = new Map<string, string[]>();
  const additionalCodes = new Map<string, string>();
  const measures: Array<Extract<CommodityResponse['included'][number], { type: 'measure' }>> = [];

  for (const res of parsed.included) {
    switch (res.type) {
      case 'duty_expression':
        if (
          'attributes' in res &&
          typeof res.attributes === 'object' &&
          res.attributes &&
          'base' in res.attributes
        ) {
          dutyExpressions.set(
            String(res.id),
            stripHtml(String((res.attributes as { base?: string | null }).base ?? '')),
          );
        }
        break;
      case 'geographical_area': {
        const rel = (
          res as {
            relationships?: { children_geographical_areas?: { data?: Array<{ id: string }> } };
          }
        ).relationships;
        const children = rel?.children_geographical_areas?.data?.map((c) => c.id) ?? [];
        geoMembers.set(String(res.id), children);
        break;
      }
      case 'additional_code': {
        const attrs = (res as { attributes?: { code?: string } }).attributes;
        if (attrs?.code) additionalCodes.set(String(res.id), attrs.code);
        break;
      }
      case 'measure':
        measures.push(res as (typeof measures)[number]);
        break;
      default:
        break;
    }
  }

  const importMeasureIds = new Set(
    parsed.data.relationships?.import_measures?.data?.map((m) => m.id) ?? [],
  );

  const out: RawTariffMeasure[] = [];
  for (const m of measures) {
    if (m.attributes.import === false) continue;
    if (importMeasureIds.size > 0 && !importMeasureIds.has(m.id) && m.attributes.import !== true)
      continue;
    const typeId = m.relationships.measure_type?.data?.id;
    const geoId = m.relationships.geographical_area?.data?.id;
    if (!typeId || !geoId) continue; // cannot be interpreted safely → dropped; engine fails closed if nothing remains
    const dutyRef = m.relationships.duty_expression?.data?.id;
    const dutyExpression = dutyRef ? (dutyExpressions.get(dutyRef) ?? '') : '';
    const addRef = m.relationships.additional_code?.data?.id;
    const excluded = m.relationships.excluded_countries?.data?.map((c) => c.id) ?? [];
    const members = geoMembers.get(geoId);
    const measure: RawTariffMeasure = {
      sid: m.id,
      measureTypeId: typeId,
      dutyExpression,
      geographicalAreaId: geoId,
      additionalCode: addRef ? (additionalCodes.get(addRef) ?? addRef) : null,
      effectiveStartDate: m.attributes.effective_start_date ?? null,
      effectiveEndDate: m.attributes.effective_end_date ?? null,
    };
    if (members && members.length > 0) measure.geographicalAreaMembers = members;
    if (excluded.length > 0) measure.excludedCountries = excluded;
    out.push(measure);
  }

  return {
    code: parsed.data.attributes.goods_nomenclature_item_id,
    description: stripHtml(parsed.data.attributes.description ?? ''),
    declarable: parsed.data.attributes.declarable ?? true,
    measures: out,
  };
};

/** Extract declarable 10-digit commodities under a heading as HS-normalisation candidates. */
export const normaliseHeadingCandidates = (raw: unknown): HsCandidate[] => {
  const parsed: HeadingResponse = headingResponseSchema.parse(raw);
  const out: HsCandidate[] = [];
  for (const res of parsed.included) {
    if (res.type !== 'commodity') continue;
    const code = res.attributes.goods_nomenclature_item_id;
    if (!code || code.length !== 10) continue;
    if (res.attributes.declarable === false || res.attributes.leaf === false) continue;
    const rate = res.attributes.basic_duty_rate;
    const candidate: HsCandidate = {
      code,
      thirdCountryDuty: rate ? stripHtml(rate) : null,
    };
    if (res.attributes.description) candidate.description = stripHtml(res.attributes.description);
    out.push(candidate);
  }
  return out;
};
