import { z } from 'zod';

/**
 * zod schemas for the subset of the UK Trade Tariff API v2 (JSON:API) that we consume.
 * Everything is `.loose()`/optional where the API is known to vary: a malformed response must
 * fail validation loudly (→ TARIFF_AMBIGUOUS upstream), never mis-price (§7.5).
 *
 * Endpoint: GET https://www.trade-tariff.service.gov.uk/api/v2/commodities/{10-digit code}
 */

const relationshipRef = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  type: z.string(),
});
const oneRelationship = z.object({ data: relationshipRef.nullable().optional() }).optional();
const manyRelationship = z.object({ data: z.array(relationshipRef).optional() }).optional();

export const measureResourceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  type: z.literal('measure'),
  attributes: z
    .object({
      effective_start_date: z.string().nullable().optional(),
      effective_end_date: z.string().nullable().optional(),
      import: z.boolean().optional(),
      vat: z.boolean().optional(),
      excise: z.boolean().optional(),
    })
    .loose(),
  relationships: z
    .object({
      duty_expression: oneRelationship,
      measure_type: oneRelationship,
      geographical_area: oneRelationship,
      additional_code: oneRelationship,
      excluded_countries: manyRelationship,
    })
    .loose(),
});

export const dutyExpressionResourceSchema = z.object({
  id: z.string(),
  type: z.literal('duty_expression'),
  attributes: z
    .object({
      base: z.string().nullable().optional(),
      verbose_duty: z.string().nullable().optional(),
    })
    .loose(),
});

export const geographicalAreaResourceSchema = z.object({
  id: z.string(),
  type: z.literal('geographical_area'),
  attributes: z
    .object({ description: z.string().optional(), geographical_area_id: z.string().optional() })
    .loose(),
  relationships: z.object({ children_geographical_areas: manyRelationship }).loose().optional(),
});

export const additionalCodeResourceSchema = z.object({
  id: z.string(),
  type: z.literal('additional_code'),
  attributes: z
    .object({ code: z.string().optional(), formatted_code: z.string().optional() })
    .loose(),
});

const otherResourceSchema = z
  .object({ id: z.union([z.string(), z.number()]).transform(String), type: z.string() })
  .loose();

export const includedResourceSchema = z.union([
  measureResourceSchema,
  dutyExpressionResourceSchema,
  geographicalAreaResourceSchema,
  additionalCodeResourceSchema,
  otherResourceSchema,
]);

export const commodityResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    type: z.literal('commodity'),
    attributes: z
      .object({
        goods_nomenclature_item_id: z.string(),
        description: z.string().optional(),
        declarable: z.boolean().optional(),
      })
      .loose(),
    relationships: z.object({ import_measures: manyRelationship }).loose().optional(),
  }),
  included: z.array(includedResourceSchema).default([]),
});

export type CommodityResponse = z.infer<typeof commodityResponseSchema>;

/** GET /api/v2/headings/{4-digit} — used to list 10-digit children for HS normalisation. */
export const headingResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    type: z.literal('heading'),
    attributes: z
      .object({ goods_nomenclature_item_id: z.string(), description: z.string().optional() })
      .loose(),
  }),
  included: z
    .array(
      z
        .object({
          id: z.string(),
          type: z.string(),
          attributes: z
            .object({
              goods_nomenclature_item_id: z.string().optional(),
              description: z.string().optional(),
              declarable: z.boolean().optional(),
              leaf: z.boolean().optional(),
              basic_duty_rate: z.string().nullable().optional(),
            })
            .loose(),
        })
        .loose(),
    )
    .default([]),
});

export type HeadingResponse = z.infer<typeof headingResponseSchema>;
