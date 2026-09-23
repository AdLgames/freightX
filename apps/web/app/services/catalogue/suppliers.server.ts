import {
  TenantScopeError,
  recordAudit,
  type Prisma,
  type TenantTransactionClient,
} from '@harbour/db';
import {
  supplierDisplayName,
  type PaymentTermsInput,
  type PickupLocationInput,
  type SupplierFormInput,
} from '../../validators/supplier';
import type { Actor } from './products.server';

/**
 * Supplier persistence — M3 (ADR-0012): the legal entity on `Supplier`, physical entities on
 * `PickupLocation` (one default per supplier, enforced by a partial unique index) and one
 * `PaymentTerms` row per supplier. `PayoutMethod` has no code path here on purpose: nothing
 * writes partner references until a payments partner is signed.
 *
 * Every function takes the SCOPED transaction client from `withOrg` and audits with the same
 * `tx`. `countryCode` (deprecated) is written alongside `countryOfIncorporation` until M4 removes
 * it (decisions-needed (w)); `name` is the display name derived from the legal/trading names.
 */

export const pickupSelect = {
  id: true,
  name: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postcode: true,
  country: true,
  closestPortCode: true,
  isDefault: true,
} satisfies Prisma.PickupLocationSelect;

export type PickupLocationRecord = Prisma.PickupLocationGetPayload<{
  select: typeof pickupSelect;
}>;

export const paymentTermsSelect = {
  termType: true,
  depositPct: true,
  balanceTrigger: true,
  netDays: true,
} satisfies Prisma.PaymentTermsSelect;

export const supplierSelect = {
  id: true,
  name: true,
  legalName: true,
  tradingName: true,
  registrationNumber: true,
  countryOfIncorporation: true,
  defaultCurrency: true,
  defaultIncoterm: true,
  archivedAt: true,
  updatedAt: true,
  pickupLocations: {
    select: pickupSelect,
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  },
  paymentTerms: { select: paymentTermsSelect },
  _count: { select: { products: true } },
} satisfies Prisma.SupplierSelect;

export type SupplierRecord = Prisma.SupplierGetPayload<{ select: typeof supplierSelect }>;

export interface SupplierView {
  id: string;
  name: string;
  legalName: string;
  tradingName: string | null;
  registrationNumber: string | null;
  countryOfIncorporation: string;
  defaultCurrency: string | null;
  defaultIncoterm: string | null;
  archivedAt: string | null;
  productCount: number;
  pickupLocations: PickupLocationRecord[];
  paymentTerms: {
    termType: string;
    depositPct: string | null;
    balanceTrigger: string | null;
    netDays: number | null;
  } | null;
}

export const toSupplierView = (s: SupplierRecord): SupplierView => ({
  id: s.id,
  name: s.name,
  legalName: s.legalName,
  tradingName: s.tradingName,
  registrationNumber: s.registrationNumber,
  countryOfIncorporation: s.countryOfIncorporation,
  defaultCurrency: s.defaultCurrency,
  defaultIncoterm: s.defaultIncoterm,
  archivedAt: s.archivedAt?.toISOString() ?? null,
  productCount: s._count.products,
  pickupLocations: s.pickupLocations,
  paymentTerms: s.paymentTerms
    ? {
        termType: s.paymentTerms.termType,
        depositPct: s.paymentTerms.depositPct?.toFixed(2) ?? null,
        balanceTrigger: s.paymentTerms.balanceTrigger,
        netDays: s.paymentTerms.netDays,
      }
    : null,
});

export const listSuppliers = (
  tx: TenantTransactionClient,
  filter: { archived: boolean },
): Promise<SupplierRecord[]> =>
  tx.supplier.findMany({
    where: { archivedAt: filter.archived ? { not: null } : null },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: supplierSelect,
  });

/** Active suppliers for the product form's picker. */
export const supplierOptions = (
  tx: TenantTransactionClient,
): Promise<Array<{ id: string; name: string; defaultCurrency: string | null }>> =>
  tx.supplier.findMany({
    where: { archivedAt: null },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true, defaultCurrency: true },
  });

export const getSupplier = (
  tx: TenantTransactionClient,
  id: string,
): Promise<SupplierRecord | null> =>
  tx.supplier.findUnique({ where: { id }, select: supplierSelect });

export type SupplierWriteError = 'NOT_FOUND';
export type SupplierWriteResult =
  { ok: true; id: string } | { ok: false; error: SupplierWriteError };

const isNotInScope = (err: unknown): boolean =>
  err instanceof TenantScopeError && err.code === 'NOT_FOUND_IN_SCOPE';

const supplierData = (input: SupplierFormInput) => ({
  name: supplierDisplayName({ legalName: input.legalName, tradingName: input.tradingName ?? null }),
  legalName: input.legalName,
  tradingName: input.tradingName ?? null,
  registrationNumber: input.registrationNumber ?? null,
  countryOfIncorporation: input.countryOfIncorporation,
  countryCode: input.countryOfIncorporation, // deprecated alias, kept in step (decisions-needed (w))
  defaultCurrency: input.defaultCurrency ?? null,
  defaultIncoterm: input.defaultIncoterm ?? null,
});

export const createSupplier = async (
  tx: TenantTransactionClient,
  actor: Actor,
  input: SupplierFormInput,
): Promise<{ id: string }> => {
  const created = await tx.supplier.create({
    data: { organizationId: actor.organizationId, ...supplierData(input) },
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'supplier.create',
    targetType: 'Supplier',
    targetId: created.id,
    metadata: { countryOfIncorporation: input.countryOfIncorporation },
  });
  return created;
};

export const updateSupplier = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  input: SupplierFormInput,
): Promise<SupplierWriteResult> => {
  const existing = await tx.supplier.findUnique({
    where: { id },
    select: {
      legalName: true,
      tradingName: true,
      registrationNumber: true,
      countryOfIncorporation: true,
      defaultCurrency: true,
      defaultIncoterm: true,
    },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  const data = supplierData(input);
  const changed = (Object.keys(existing) as Array<keyof typeof existing>).filter(
    (k) => (existing[k] ?? null) !== (data[k] ?? null),
  );
  try {
    await tx.supplier.update({ where: { id }, data, select: { id: true } });
  } catch (err) {
    if (isNotInScope(err)) return { ok: false, error: 'NOT_FOUND' };
    throw err;
  }
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'supplier.update',
    targetType: 'Supplier',
    targetId: id,
    metadata: { changed },
  });
  return { ok: true, id };
};

const setSupplierArchived = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  archived: boolean,
): Promise<SupplierWriteResult> => {
  try {
    await tx.supplier.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
      select: { id: true },
    });
  } catch (err) {
    if (isNotInScope(err)) return { ok: false, error: 'NOT_FOUND' };
    throw err;
  }
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: archived ? 'supplier.archive' : 'supplier.restore',
    targetType: 'Supplier',
    targetId: id,
  });
  return { ok: true, id };
};

/** Archive instead of delete: products and (later) quotes keep referencing the supplier. */
export const archiveSupplier = (tx: TenantTransactionClient, actor: Actor, id: string) =>
  setSupplierArchived(tx, actor, id, true);

export const restoreSupplier = (tx: TenantTransactionClient, actor: Actor, id: string) =>
  setSupplierArchived(tx, actor, id, false);

// ---------- pickup locations ----------

const pickupData = (input: PickupLocationInput) => ({
  name: input.name,
  addressLine1: input.addressLine1 ?? null,
  addressLine2: input.addressLine2 ?? null,
  city: input.city ?? null,
  region: input.region ?? null,
  postcode: input.postcode ?? null,
  country: input.country,
  closestPortCode: input.closestPortCode,
});

/** Clears the default flag on every location of the supplier (the partial unique index allows one). */
const clearDefault = (tx: TenantTransactionClient, supplierId: string) =>
  tx.pickupLocation.updateMany({
    where: { supplierId, isDefault: true },
    data: { isDefault: false },
  });

export const addPickupLocation = async (
  tx: TenantTransactionClient,
  actor: Actor,
  supplierId: string,
  input: PickupLocationInput,
): Promise<SupplierWriteResult> => {
  const supplier = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true },
  });
  if (!supplier) return { ok: false, error: 'NOT_FOUND' };
  const existing = await tx.pickupLocation.count({ where: { supplierId } });
  // The first location is the default whatever the box says; a later one only when asked.
  const isDefault = existing === 0 || input.isDefault;
  if (isDefault) await clearDefault(tx, supplierId);
  const created = await tx.pickupLocation.create({
    data: { organizationId: actor.organizationId, supplierId, isDefault, ...pickupData(input) },
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'pickup_location.create',
    targetType: 'PickupLocation',
    targetId: created.id,
    metadata: {
      supplierId,
      country: input.country,
      closestPortCode: input.closestPortCode,
      isDefault,
    },
  });
  return { ok: true, id: created.id };
};

export const updatePickupLocation = async (
  tx: TenantTransactionClient,
  actor: Actor,
  supplierId: string,
  id: string,
  input: PickupLocationInput,
): Promise<SupplierWriteResult> => {
  const existing = await tx.pickupLocation.findUnique({
    where: { id, supplierId },
    select: { id: true, isDefault: true },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (input.isDefault && !existing.isDefault) await clearDefault(tx, supplierId);
  await tx.pickupLocation.update({
    where: { id, supplierId },
    data: { ...pickupData(input), isDefault: input.isDefault },
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'pickup_location.update',
    targetType: 'PickupLocation',
    targetId: id,
    metadata: {
      supplierId,
      country: input.country,
      closestPortCode: input.closestPortCode,
      isDefault: input.isDefault,
    },
  });
  return { ok: true, id };
};

export const setDefaultPickupLocation = async (
  tx: TenantTransactionClient,
  actor: Actor,
  supplierId: string,
  id: string,
): Promise<SupplierWriteResult> => {
  const existing = await tx.pickupLocation.findUnique({
    where: { id, supplierId },
    select: { id: true },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  await clearDefault(tx, supplierId);
  await tx.pickupLocation.update({
    where: { id, supplierId },
    data: { isDefault: true },
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'pickup_location.update',
    targetType: 'PickupLocation',
    targetId: id,
    metadata: { supplierId, isDefault: true },
  });
  return { ok: true, id };
};

export const removePickupLocation = async (
  tx: TenantTransactionClient,
  actor: Actor,
  supplierId: string,
  id: string,
): Promise<SupplierWriteResult> => {
  const existing = await tx.pickupLocation.findUnique({
    where: { id, supplierId },
    select: { id: true, isDefault: true },
  });
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  await tx.pickupLocation.delete({ where: { id, supplierId }, select: { id: true } });
  if (existing.isDefault) {
    // Promote the oldest remaining location so the supplier keeps a default.
    const next = await tx.pickupLocation.findFirst({
      where: { supplierId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (next) {
      await tx.pickupLocation.update({
        where: { id: next.id, supplierId },
        data: { isDefault: true },
        select: { id: true },
      });
    }
  }
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'pickup_location.delete',
    targetType: 'PickupLocation',
    targetId: id,
    metadata: { supplierId },
  });
  return { ok: true, id };
};

// ---------- payment terms ----------

export const upsertPaymentTerms = async (
  tx: TenantTransactionClient,
  actor: Actor,
  supplierId: string,
  input: PaymentTermsInput,
): Promise<SupplierWriteResult> => {
  const supplier = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true },
  });
  if (!supplier) return { ok: false, error: 'NOT_FOUND' };
  const data = {
    termType: input.termType,
    depositPct: input.depositPct,
    balanceTrigger: input.balanceTrigger,
    netDays: input.netDays,
  };
  const row = await tx.paymentTerms.upsert({
    where: { supplierId },
    create: { organizationId: actor.organizationId, supplierId, ...data },
    update: data,
    select: { id: true },
  });
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'payment_terms.update',
    targetType: 'PaymentTerms',
    targetId: row.id,
    metadata: {
      supplierId,
      termType: input.termType,
      balanceTrigger: input.balanceTrigger,
      netDays: input.netDays,
      depositPct: input.depositPct,
    },
  });
  return { ok: true, id: row.id };
};
