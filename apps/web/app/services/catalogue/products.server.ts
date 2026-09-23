import { Prisma, TenantScopeError, recordAudit, type TenantTransactionClient } from '@harbour/db';

/**
 * Product catalogue persistence — M3. Every function takes the SCOPED transaction client from
 * `withOrg` (Prisma tenant scope + RLS) and an `Actor` for the audit row that commits with the
 * change. Nothing here reads the organisation from anywhere but the scope.
 *
 * Products are archived, never deleted: quote lines snapshot them but still reference the row.
 * Audit metadata carries ids, enum values and field NAMES only (§7.3) — never the SKU or name.
 */

export interface Actor {
  organizationId: string;
  userId: string;
}

export const productSelect = {
  id: true,
  sku: true,
  name: true,
  supplierId: true,
  supplier: { select: { id: true, name: true, archivedAt: true } },
  originCountry: true,
  unitValue: true,
  currency: true,
  weightKg: true,
  volumeCbm: true,
  unitsPerCarton: true,
  cartonLengthCm: true,
  cartonWidthCm: true,
  cartonHeightCm: true,
  hsCode: true,
  hsCodeVerifiedAt: true,
  hsDescription: true,
  preferenceEligible: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSelect;

export type ProductRecord = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

/** JSON-safe shape for loaders: Decimals as strings, dates as ISO strings. */
export interface ProductView {
  id: string;
  sku: string;
  name: string;
  supplier: { id: string; name: string; archived: boolean } | null;
  originCountry: string;
  unitValue: string;
  currency: string;
  weightKg: string;
  volumeCbm: string;
  unitsPerCarton: number | null;
  cartonLengthCm: string | null;
  cartonWidthCm: string | null;
  cartonHeightCm: string | null;
  hsCode: string;
  hsCodeVerifiedAt: string | null;
  hsDescription: string | null;
  preferenceEligible: boolean;
  archivedAt: string | null;
  updatedAt: string;
}

const dec = (d: Prisma.Decimal | null, dp: number): string | null =>
  d === null ? null : d.toFixed(dp);

export const toProductView = (p: ProductRecord): ProductView => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  supplier: p.supplier
    ? { id: p.supplier.id, name: p.supplier.name, archived: p.supplier.archivedAt !== null }
    : null,
  originCountry: p.originCountry,
  unitValue: p.unitValue.toFixed(4),
  currency: p.currency,
  weightKg: p.weightKg.toFixed(3),
  volumeCbm: p.volumeCbm.toFixed(4),
  unitsPerCarton: p.unitsPerCarton,
  cartonLengthCm: dec(p.cartonLengthCm, 2),
  cartonWidthCm: dec(p.cartonWidthCm, 2),
  cartonHeightCm: dec(p.cartonHeightCm, 2),
  hsCode: p.hsCode,
  hsCodeVerifiedAt: p.hsCodeVerifiedAt?.toISOString() ?? null,
  hsDescription: p.hsDescription,
  preferenceEligible: p.preferenceEligible,
  archivedAt: p.archivedAt?.toISOString() ?? null,
  updatedAt: p.updatedAt.toISOString(),
});

export interface ProductFilter {
  /** Case-insensitive substring of SKU or name. */
  q?: string | undefined;
  /** true → archived products only; false → active only. */
  archived: boolean;
}

export const listProducts = async (
  tx: TenantTransactionClient,
  filter: ProductFilter,
): Promise<ProductRecord[]> => {
  const q = filter.q?.trim();
  return tx.product.findMany({
    where: {
      archivedAt: filter.archived ? { not: null } : null,
      ...(q
        ? {
            OR: [
              { sku: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ sku: 'asc' }, { id: 'asc' }],
    select: productSelect,
  });
};

export const getProduct = (
  tx: TenantTransactionClient,
  id: string,
): Promise<ProductRecord | null> => tx.product.findUnique({ where: { id }, select: productSelect });

/** What the tariff lookup established for the code being saved (see product-form.server.ts). */
export interface HsVerification {
  verifiedAt: Date | null;
  description: string | null;
  preferenceEligible: boolean;
}

export interface ProductWrite {
  sku: string;
  name: string;
  supplierId: string | null;
  originCountry: string;
  unitValue: string;
  currency: string;
  weightKg: string;
  volumeCbm: string;
  cartonLengthCm: string | null;
  cartonWidthCm: string | null;
  cartonHeightCm: string | null;
  unitsPerCarton: number | null;
  hsCode: string;
  hs: HsVerification;
}

export type ProductWriteError = 'SKU_TAKEN' | 'SUPPLIER_NOT_FOUND' | 'NOT_FOUND';
export type ProductWriteResult = { ok: true; id: string } | { ok: false; error: ProductWriteError };

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const isNotInScope = (err: unknown): boolean =>
  err instanceof TenantScopeError && err.code === 'NOT_FOUND_IN_SCOPE';

const writeData = (input: ProductWrite) => ({
  sku: input.sku,
  name: input.name,
  supplierId: input.supplierId,
  originCountry: input.originCountry,
  unitValue: input.unitValue,
  currency: input.currency,
  weightKg: input.weightKg,
  volumeCbm: input.volumeCbm,
  cartonLengthCm: input.cartonLengthCm,
  cartonWidthCm: input.cartonWidthCm,
  cartonHeightCm: input.cartonHeightCm,
  unitsPerCarton: input.unitsPerCarton,
  hsCode: input.hsCode,
  hsCodeVerifiedAt: input.hs.verifiedAt,
  hsDescription: input.hs.description,
  preferenceEligible: input.hs.preferenceEligible,
});

/** The supplier must exist in THIS organisation (the scoped read returns null for any other). */
const supplierUsable = async (
  tx: TenantTransactionClient,
  supplierId: string | null,
  previousSupplierId: string | null,
): Promise<boolean> => {
  if (supplierId === null) return true;
  const s = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: { id: true, archivedAt: true },
  });
  if (!s) return false;
  // An archived supplier stays selectable only if the product already used it.
  return s.archivedAt === null || supplierId === previousSupplierId;
};

export const createProduct = async (
  tx: TenantTransactionClient,
  actor: Actor,
  input: ProductWrite,
): Promise<ProductWriteResult> => {
  if (!(await supplierUsable(tx, input.supplierId, null))) {
    return { ok: false, error: 'SUPPLIER_NOT_FOUND' };
  }
  let id: string;
  try {
    const created = await tx.product.create({
      data: { organizationId: actor.organizationId, ...writeData(input) },
      select: { id: true },
    });
    id = created.id;
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'SKU_TAKEN' };
    throw err;
  }
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'product.create',
    targetType: 'Product',
    targetId: id,
    metadata: {
      supplierId: input.supplierId,
      hsVerified: input.hs.verifiedAt !== null,
      volumeSource: input.cartonLengthCm !== null ? 'CARTON' : 'ENTERED',
    },
  });
  return { ok: true, id };
};

const WRITE_FIELDS = [
  'sku',
  'name',
  'supplierId',
  'originCountry',
  'unitValue',
  'currency',
  'weightKg',
  'volumeCbm',
  'cartonLengthCm',
  'cartonWidthCm',
  'cartonHeightCm',
  'unitsPerCarton',
  'hsCode',
] as const;

/** Names of the fields whose stored value differs from the new input (for the audit row). */
export const changedProductFields = (existing: ProductRecord, input: ProductWrite): string[] => {
  const before = toProductView(existing);
  const changed: string[] = [];
  const text = (v: string | number | null | undefined): string =>
    v === null || v === undefined ? '' : String(v);
  // Decimal columns read back padded ("0.800"); compare numerically so "0.8" is not a change.
  const same = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (a === '' || b === '') return false;
    if (!/^\d+(\.\d+)?$/.test(a) || !/^\d+(\.\d+)?$/.test(b)) return false;
    return new Prisma.Decimal(a).equals(new Prisma.Decimal(b));
  };
  for (const f of WRITE_FIELDS) {
    const was = f === 'supplierId' ? (before.supplier?.id ?? null) : before[f];
    if (!same(text(was), text(input[f]))) changed.push(f);
  }
  if ((existing.hsCodeVerifiedAt !== null) !== (input.hs.verifiedAt !== null)) {
    changed.push('hsCodeVerifiedAt');
  }
  return changed;
};

export const updateProduct = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  input: ProductWrite,
): Promise<ProductWriteResult> => {
  const existing = await getProduct(tx, id);
  if (!existing) return { ok: false, error: 'NOT_FOUND' };
  if (!(await supplierUsable(tx, input.supplierId, existing.supplierId))) {
    return { ok: false, error: 'SUPPLIER_NOT_FOUND' };
  }
  try {
    await tx.product.update({ where: { id }, data: writeData(input), select: { id: true } });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'SKU_TAKEN' };
    if (isNotInScope(err)) return { ok: false, error: 'NOT_FOUND' };
    throw err;
  }
  await recordAudit(tx, {
    organizationId: actor.organizationId,
    userId: actor.userId,
    action: 'product.update',
    targetType: 'Product',
    targetId: id,
    metadata: {
      changed: changedProductFields(existing, input),
      hsVerified: input.hs.verifiedAt !== null,
    },
  });
  return { ok: true, id };
};

const setArchived = async (
  tx: TenantTransactionClient,
  actor: Actor,
  id: string,
  archived: boolean,
): Promise<ProductWriteResult> => {
  try {
    await tx.product.update({
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
    action: archived ? 'product.archive' : 'product.restore',
    targetType: 'Product',
    targetId: id,
  });
  return { ok: true, id };
};

/** Archive instead of delete: existing quotes keep referencing the row. */
export const archiveProduct = (tx: TenantTransactionClient, actor: Actor, id: string) =>
  setArchived(tx, actor, id, true);

export const restoreProduct = (tx: TenantTransactionClient, actor: Actor, id: string) =>
  setArchived(tx, actor, id, false);
