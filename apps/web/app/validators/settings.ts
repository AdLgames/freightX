import { ROLES } from '@harbour/db';
import { z } from 'zod';
import { emailSchema, organizationNameSchema } from './auth';
import {
  checkbox,
  currency,
  danNumber,
  decimalString,
  eori,
  optionalField,
  safeString,
  vatNumber,
} from './common';

/**
 * Settings form schemas (M2; brief §5.6, §7.5). Every settings action parses its form through one
 * of these before touching the database. Values are trimmed and bounded; EORI/VAT/DAN reuse the
 * shared validators (upper-cased, whitespace stripped, check digit for VAT).
 */

// ---------- organisation ----------

export const organizationDetailsSchema = z.object({
  name: organizationNameSchema,
  baseCurrency: currency,
});

/** Identity step (UX spec 1): the EORI on its own. Blank clears it. */
export const eoriFormSchema = z
  .object({ eoriNumber: optionalField(eori) })
  .transform((v) => ({ eoriNumber: v.eoriNumber ?? null }));
export type EoriFormInput = z.infer<typeof eoriFormSchema>;

const yesNo = z.enum(['yes', 'no'], { error: 'Choose yes or no.' }).transform((v) => v === 'yes');

/**
 * VAT step (UX spec 2). `number` is `undefined` when the field was left blank while registered,
 * which means "keep the number already stored" (the form never shows the stored value in full).
 */
export const vatFormSchema = z
  .object({
    vatRegistered: yesNo,
    vatNumber: optionalField(vatNumber),
  })
  .transform((v) => ({
    registered: v.vatRegistered,
    number: v.vatRegistered ? v.vatNumber : null,
  }));
export type VatFormInput = z.infer<typeof vatFormSchema>;

// ---------- company lookup (UX spec 1b, ADR-0015) ----------

export const companySearchSchema = z.object({
  query: safeString(200, 1),
});

export const COMPANY_NUMBER_RE = /^[A-Z0-9]{8}$/;

/** The user confirms a number from the search results; the record itself is re-read from the API. */
export const companyConfirmSchema = z.object({
  companyNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(COMPANY_NUMBER_RE, 'Choose one of the companies listed.'),
});

// ---------- customs profile (UX spec 2–4) ----------

export const PAYMENT_METHODS = ['BROKER_DEFERMENT', 'OWN_DEFERMENT', 'CDS_CASH_ACCOUNT'] as const;
export type PaymentMethodInput = (typeof PAYMENT_METHODS)[number];

export const customsProfileSchema = z
  .object({
    usePva: checkbox,
    paymentMethod: z.enum(PAYMENT_METHODS, { error: 'Choose how duty will be paid.' }),
    brokerDefermentFeePct: optionalField(decimalString({ dp: 2, max: '100' })),
    brokerDefermentMinimumGbp: optionalField(decimalString({ dp: 2, max: '100000' })),
    danNumber: optionalField(danNumber),
    cdsAuthorityConfirmed: checkbox,
  })
  .superRefine((v, ctx) => {
    if (v.paymentMethod === 'OWN_DEFERMENT' && v.danNumber === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['danNumber'],
        message: 'Enter your deferment account number (DAN) to use your own account.',
      });
    }
  })
  .transform((v) => ({
    usePva: v.usePva,
    paymentMethod: v.paymentMethod,
    // Fee terms belong to the forwarder's deferment only; blank = unknown (null).
    brokerDefermentFeePct:
      v.paymentMethod === 'BROKER_DEFERMENT' ? (v.brokerDefermentFeePct ?? null) : null,
    brokerDefermentMinimumGbp:
      v.paymentMethod === 'BROKER_DEFERMENT' ? (v.brokerDefermentMinimumGbp ?? null) : null,
    danNumber: v.danNumber ?? null,
    cdsAuthorityConfirmed: v.paymentMethod === 'OWN_DEFERMENT' && v.cdsAuthorityConfirmed,
  }));
export type CustomsProfileInput = z.infer<typeof customsProfileSchema>;

// ---------- members and invitations ----------

export const roleSchema = z.enum(ROLES, { error: 'Choose a role.' });

export const inviteSchema = z.object({
  email: emailSchema,
  role: roleSchema,
});

export const changeRoleSchema = z.object({
  membershipId: z.uuid({ error: 'Choose a member.' }),
  role: roleSchema,
});

export const membershipIdSchema = z.object({
  membershipId: z.uuid({ error: 'Choose a member.' }),
});

export const invitationIdSchema = z.object({
  invitationId: z.uuid({ error: 'Choose an invitation.' }),
});

/**
 * The invitation link token: `<organisation uuid>.<43-char base64url secret>`. The uuid selects
 * the tenant context for the lookup (RLS), the secret is the credential (only its sha256 is
 * stored). Anything else is "not a valid invitation".
 */
export const INVITE_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export const inviteTokenSchema = z
  .string()
  .trim()
  .max(120)
  .transform((raw, ctx) => {
    const dot = raw.indexOf('.');
    const organizationId = dot > 0 ? raw.slice(0, dot) : '';
    const secret = dot > 0 ? raw.slice(dot + 1) : '';
    if (!z.uuid().safeParse(organizationId).success || !INVITE_SECRET_RE.test(secret)) {
      ctx.addIssue({ code: 'custom', message: 'That invitation link is not valid.' });
      return z.NEVER;
    }
    return { organizationId, secret };
  });
export type InviteToken = z.infer<typeof inviteTokenSchema>;

// ---------- audit log ----------

export const AUDIT_PAGE_SIZE = 25;

export const auditPageSchema = z.coerce.number().int().min(1).max(100_000).catch(1);
