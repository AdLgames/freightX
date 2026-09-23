import { z } from 'zod';
import { INCOTERMS } from './calculator';
import { checkbox, currency, locode, optionalField, safeString } from './common';
import { knownCountry, percentString } from './product';

/**
 * Supplier, pickup location and payment terms forms — M3 (ADR-0012). The enum arrays mirror the
 * Prisma enums by value; this module is imported by route components, so it must not import
 * `@harbour/db` (the generated client is server-only).
 */

export const PAYMENT_TERM_TYPES = ['PREPAID', 'NET', 'DEPOSIT_BALANCE'] as const;
export type PaymentTermTypeCode = (typeof PAYMENT_TERM_TYPES)[number];

export const PAYMENT_TERM_LABELS: Record<PaymentTermTypeCode, string> = {
  PREPAID: 'Paid in full before shipment',
  NET: 'Net terms (invoice due after a number of days)',
  DEPOSIT_BALANCE: 'Deposit now, balance later',
};

export const BALANCE_TRIGGERS = ['ON_SHIPMENT', 'AGAINST_BILL_OF_LADING', 'ON_ARRIVAL'] as const;
export type BalanceTriggerCode = (typeof BALANCE_TRIGGERS)[number];

export const BALANCE_TRIGGER_LABELS: Record<BalanceTriggerCode, string> = {
  ON_SHIPMENT: 'When the goods ship',
  AGAINST_BILL_OF_LADING: 'Against the bill of lading',
  ON_ARRIVAL: 'When the goods arrive',
};

export const INCOTERM_LABELS: Record<(typeof INCOTERMS)[number], string> = {
  EXW: 'EXW: I pay from the factory door',
  FCA: 'FCA: supplier hands over to my carrier',
  FOB: 'FOB: supplier pays to the port',
  CFR: 'CFR: supplier pays freight to the UK port',
  CIF: 'CIF: supplier pays freight and insurance to the UK port',
  DAP: 'DAP: supplier delivers to my door',
  DPU: 'DPU: supplier delivers and unloads',
  DDP: 'DDP: supplier pays duty and VAT too',
};

// ---------- supplier ----------

export const SUPPLIER_FIELDS = [
  'legalName',
  'tradingName',
  'registrationNumber',
  'countryOfIncorporation',
  'defaultCurrency',
  'defaultIncoterm',
] as const;

export const supplierFormSchema = z.object({
  legalName: safeString(200, 1),
  tradingName: optionalField(safeString(200)),
  registrationNumber: optionalField(safeString(64)),
  countryOfIncorporation: knownCountry,
  defaultCurrency: optionalField(currency),
  defaultIncoterm: optionalField(z.enum(INCOTERMS, { error: 'Choose an incoterm.' })),
});

export type SupplierFormInput = z.infer<typeof supplierFormSchema>;

/** The display name shown in lists and product pickers: trading name when given, else legal name. */
export const supplierDisplayName = (s: {
  legalName: string;
  tradingName: string | null;
}): string => (s.tradingName && s.tradingName.trim() !== '' ? s.tradingName : s.legalName);

// ---------- payment terms ----------

export const PAYMENT_TERMS_FIELDS = [
  'termType',
  'depositPct',
  'balanceTrigger',
  'netDays',
] as const;

export const paymentTermsFormSchema = z
  .object({
    termType: z.enum(PAYMENT_TERM_TYPES, { error: 'Choose the payment terms.' }),
    /** Percent convention: "30.00" = 30% (ADR-0012). */
    depositPct: optionalField(percentString),
    balanceTrigger: optionalField(
      z.enum(BALANCE_TRIGGERS, { error: 'Choose what releases the balance.' }),
    ),
    netDays: optionalField(
      z.coerce
        .number({ error: 'Enter a whole number of days.' })
        .int('Days must be a whole number.')
        .min(0, 'Days cannot be negative.')
        .max(365, 'Days must be 365 or fewer.'),
    ),
  })
  .superRefine((v, ctx) => {
    if (v.termType === 'DEPOSIT_BALANCE') {
      if (v.depositPct === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['depositPct'],
          message: 'Enter the deposit as a percentage of the order value.',
        });
      }
      if (v.balanceTrigger === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['balanceTrigger'],
          message: 'Choose what releases the balance payment.',
        });
      }
    }
    if (v.termType === 'NET' && v.netDays === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['netDays'],
        message: 'Enter the number of days the invoice is due after.',
      });
    }
  })
  .transform((v) => ({
    termType: v.termType,
    // Fields that do not apply to the chosen terms are dropped rather than stored stale.
    depositPct: v.termType === 'DEPOSIT_BALANCE' ? (v.depositPct ?? null) : null,
    balanceTrigger: v.termType === 'DEPOSIT_BALANCE' ? (v.balanceTrigger ?? null) : null,
    netDays: v.termType === 'PREPAID' ? null : (v.netDays ?? null),
  }));

export type PaymentTermsInput = z.infer<typeof paymentTermsFormSchema>;

// ---------- pickup location ----------

export const PICKUP_FIELDS = [
  'name',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postcode',
  'country',
  'closestPortCode',
  'closestPortChoice',
  'isDefault',
] as const;

/**
 * The closest port: either a pick from the rate-sheet allow-list (`closestPortChoice`) or a
 * free-text UN/LOCODE (`closestPortCode`, 5 characters, validated by pattern only). The typed code
 * wins when both are given, so a user can always name a port the rate sheet does not have yet.
 */
export const pickupLocationFormSchema = z
  .object({
    name: safeString(120, 1),
    addressLine1: optionalField(safeString(200)),
    addressLine2: optionalField(safeString(200)),
    city: optionalField(safeString(100)),
    region: optionalField(safeString(100)),
    postcode: optionalField(safeString(20)),
    country: knownCountry,
    closestPortCode: optionalField(locode()),
    closestPortChoice: optionalField(locode()),
    isDefault: checkbox,
  })
  .superRefine((v, ctx) => {
    if (v.closestPortCode === undefined && v.closestPortChoice === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['closestPortCode'],
        message: 'Choose the closest port, or enter its 5-character UN/LOCODE.',
      });
    }
  })
  .transform(({ closestPortCode, closestPortChoice, ...rest }) => ({
    ...rest,
    closestPortCode: (closestPortCode ?? closestPortChoice) as string,
  }));

export type PickupLocationInput = z.infer<typeof pickupLocationFormSchema>;

/** Actions the supplier page posts (`intent` field). */
export const SUPPLIER_INTENTS = [
  'save',
  'archive',
  'restore',
  'payment-terms',
  'pickup-add',
  'pickup-update',
  'pickup-remove',
  'pickup-default',
] as const;
export type SupplierIntent = (typeof SUPPLIER_INTENTS)[number];

export const supplierIntent = z.enum(SUPPLIER_INTENTS).catch('save');
