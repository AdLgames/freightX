import { z } from 'zod';

/**
 * HMRC identity checkers (M2, brief §5.6). zod at the boundary: only the fields the jobs use are
 * parsed. The fixtures under fixtures/hmrc are hand-authored in the documented shapes and must be
 * re-recorded against the live APIs before the parsers are trusted.
 */

export const EORI_RE = /^(GB|XI)\d{12}$/;
/** 9 digits, optionally a 3-digit branch suffix — the VRN without its `GB` prefix. */
export const VRN_RE = /^\d{9}(\d{3})?$/;

/** POST /customs/eori/lookup → an array, one element per requested EORI. */
export const eoriLookupItemSchema = z.object({
  eori: z.string().trim().toUpperCase().regex(EORI_RE),
  valid: z.boolean(),
  // Present only for valid EORIs; we do not store it (PII minimisation, §7.3).
  companyDetails: z.object({ traderName: z.string().optional() }).passthrough().optional(),
  processingDate: z.string().optional(),
});
export const eoriLookupResponseSchema = z.array(eoriLookupItemSchema).min(1).max(10);
export type EoriLookupResponse = z.infer<typeof eoriLookupResponseSchema>;

/** GET /organisations/vat/check-vat-number/lookup/{vrn} → 200 with `target`, 404 NOT_FOUND. */
export const vatCheckResponseSchema = z.object({
  target: z.object({
    name: z.string().optional(),
    vatNumber: z.string().trim().regex(VRN_RE),
  }),
  processingDate: z.string().optional(),
});
export type VatCheckResponse = z.infer<typeof vatCheckResponseSchema>;

export const hmrcErrorBodySchema = z.object({
  code: z.string().max(100),
  message: z.string().max(500).optional(),
});

/** Outcome of an identity check as the worker records it (VerificationStatus minus UNVERIFIED/PENDING). */
export type IdentityCheckResult =
  | { ok: true; valid: boolean; checkedAt: Date }
  | {
      ok: false;
      /** UNAVAILABLE: 5xx/timeout/network; BAD_REQUEST: HMRC rejected the request (4xx); MALFORMED: shape changed. */
      reason: 'UNAVAILABLE' | 'BAD_REQUEST' | 'MALFORMED';
    };
