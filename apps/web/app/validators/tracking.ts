import {
  MILESTONES,
  checkContainerNumber,
  checkImo,
  normaliseContainerNumber,
} from '@harbour/adapters/tracking/core';
import { z } from 'zod';

/**
 * M9 (ADR-0017) — form and query schemas for the tracking routes. Shared with the client for
 * rendering, so nothing here is secret. Container and IMO numbers are check-digit validated at
 * input: a mistyped number must never subscribe a stranger's container.
 */

export const LOCODE_RE = /^[A-Z]{2}[A-Z0-9]{3}$/;
export const CONTAINER_SIZE_TYPES = ['C20GP', 'C40GP', 'C40HC', 'C45HC'] as const;
export const CONTAINER_SIZE_LABELS: Readonly<
  Record<(typeof CONTAINER_SIZE_TYPES)[number], string>
> = {
  C20GP: "20' standard (20GP)",
  C40GP: "40' standard (40GP)",
  C40HC: "40' high cube (40HC)",
  C45HC: "45' high cube (45HC)",
};

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? undefined : s))
    .optional();
const optionalLocode = optionalText(5).pipe(
  z.string().toUpperCase().regex(LOCODE_RE, 'Use a 5-character UN/LOCODE, e.g. GBFXT.').optional(),
);

/** One container number per line or comma; each must pass the ISO 6346 check digit. */
export const containerNumberList = z
  .string()
  .max(2000)
  .transform((raw, ctx) => {
    const parts = raw
      .split(/[\n,;]+/)
      .map((p) => normaliseContainerNumber(p))
      .filter((p) => p !== '');
    const out: string[] = [];
    for (const part of parts) {
      const check = checkContainerNumber(part);
      if (!check.ok) {
        ctx.addIssue({ code: 'custom', message: `${part}: ${check.message}` });
        continue;
      }
      if (!out.includes(check.containerNumber)) out.push(check.containerNumber);
    }
    if (out.length > 20)
      ctx.addIssue({ code: 'custom', message: 'At most 20 containers per shipment.' });
    return out;
  });

export const trackShipmentSchema = z
  .object({
    reference: trimmed(120).min(1, 'Give the shipment a reference.'),
    containerNumbers: containerNumberList,
    masterBillNumber: optionalText(40).pipe(
      z
        .string()
        .toUpperCase()
        .regex(/^[A-Z0-9-]{4,40}$/, 'Letters, digits and hyphens only.')
        .optional(),
    ),
    originLocode: optionalLocode,
    destinationLocode: optionalLocode,
    quoteId: optionalText(40).pipe(z.uuid('Pick a quote from the list.').optional()),
    sizeType: optionalText(10).pipe(z.enum(CONTAINER_SIZE_TYPES).optional()),
  })
  .refine((v) => v.containerNumbers.length > 0 || v.masterBillNumber !== undefined, {
    message: 'Enter at least one container number or a master bill number.',
    path: ['containerNumbers'],
  });
export type TrackShipmentInput = z.infer<typeof trackShipmentSchema>;

const coordinate = (min: number, max: number, what: string) =>
  optionalText(20).pipe(
    z
      .string()
      .regex(/^-?\d{1,3}(\.\d{1,6})?$/, `${what} must be decimal degrees.`)
      .transform(Number)
      .refine((n) => n >= min && n <= max, `${what} out of range.`)
      .optional(),
  );

/** `datetime-local` input (no zone) or a full ISO string; interpreted as UTC when zoneless. */
const occurredAt = trimmed(40)
  .min(1, 'When did it happen?')
  .transform((s, ctx) => {
    const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}${s.length === 16 ? ':00' : ''}Z`;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid date and time.' });
      return z.NEVER;
    }
    return new Date(t).toISOString();
  });

export const manualEventSchema = z
  .object({
    containerId: z.uuid(),
    milestone: z.enum(MILESTONES),
    occurredAt,
    locationLocode: optionalLocode,
    locationName: optionalText(120),
    vesselImo: optionalText(12).transform((raw, ctx) => {
      if (raw === undefined) return undefined;
      const check = checkImo(raw);
      if (!check.ok) {
        ctx.addIssue({ code: 'custom', message: check.message });
        return z.NEVER;
      }
      return check.imo;
    }),
    vesselName: optionalText(120),
    voyageNumber: optionalText(40),
    latitude: coordinate(-90, 90, 'Latitude'),
    longitude: coordinate(-180, 180, 'Longitude'),
    note: optionalText(500),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    message: 'Give both latitude and longitude, or neither.',
    path: ['longitude'],
  });
export type ManualEventInput = z.infer<typeof manualEventSchema>;

export const mapStateQuerySchema = z.object({
  shipmentId: z.uuid().optional(),
});

/** Human labels for `ShipmentStatus` badges. */
export const SHIPMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING_DOCS: 'Not yet shipped',
  PENDING_BOOKING: 'Pending booking',
  BOOKED: 'Booked',
  DISPATCHED: 'At origin terminal',
  IN_TRANSIT: 'In transit',
  AT_DESTINATION: 'At destination',
  CUSTOMS: 'Customs',
  CLEARED: 'Cleared',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  EXCEPTION: 'Exception',
  CANCELLED: 'Cancelled',
};
