import { z } from 'zod';

/**
 * Companies House Public Data API (M2, ADR-0015 finance gate). zod at the boundary (§7.5): only
 * the fields we store are parsed; everything else is ignored. Field names follow the published
 * API reference; the fixtures under fixtures/companies-house are hand-authored in that shape and
 * must be re-recorded against the live API (docs/decisions-needed.md (u)).
 */

/** 8 characters: digits, or a two-letter prefix (OC, SC, NI, …) and six digits. */
export const COMPANY_NUMBER_RE = /^[A-Z0-9]{8}$/;

const companyNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(COMPANY_NUMBER_RE, 'company_number must be 8 characters');

const shortText = z.string().trim().min(1).max(200);

/** One row of `GET /search/companies`. */
export const companySearchItemSchema = z.object({
  company_number: companyNumber,
  title: shortText,
  company_status: shortText.optional(),
  company_type: shortText.optional(),
});

export const companySearchResponseSchema = z.object({
  items: z.array(companySearchItemSchema).max(100),
  total_results: z.number().int().nonnegative().optional(),
});
export type CompanySearchResponse = z.infer<typeof companySearchResponseSchema>;

/** `GET /company/{company_number}` (company profile); the type key is `type` here, not `company_type`. */
export const companyProfileSchema = z.object({
  company_number: companyNumber,
  company_name: shortText,
  company_status: shortText.optional(),
  type: shortText.optional(),
});
export type CompanyProfileResponse = z.infer<typeof companyProfileSchema>;

/** What the app stores (Organization.companiesHouse*). Status/type are the API's lower-case codes. */
export interface CompanyMatch {
  companyNumber: string;
  name: string;
  /** e.g. `active`, `dissolved`, `liquidation`; null when the API omitted it. */
  status: string | null;
  /** e.g. `ltd`, `plc`, `llp`; null when the API omitted it. */
  type: string | null;
}

export const toCompanyMatch = (item: z.infer<typeof companySearchItemSchema>): CompanyMatch => ({
  companyNumber: item.company_number,
  name: item.title,
  status: item.company_status?.toLowerCase() ?? null,
  type: item.company_type?.toLowerCase() ?? null,
});

export const profileToCompanyMatch = (p: CompanyProfileResponse): CompanyMatch => ({
  companyNumber: p.company_number,
  name: p.company_name,
  status: p.company_status?.toLowerCase() ?? null,
  type: p.type?.toLowerCase() ?? null,
});
