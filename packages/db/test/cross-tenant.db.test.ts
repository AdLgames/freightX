/**
 * Cross-tenant negative tests against a real Postgres (§8: "tests that attempt cross-org reads").
 *
 * Skipped unless DATABASE_URL is set. Requirements when it is:
 *   - migrations applied: `pnpm --filter @harbour/db run migrate:deploy`
 *   - the connection is either a non-superuser (member of harbour_app, as in production) or a
 *     superuser/BYPASSRLS role — superusers ignore RLS, so for the raw-SQL assertions this test
 *     switches to `SET LOCAL ROLE harbour_app` inside the transaction when it detects one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disposePrismaClient } from '../src/client.js';
import { recordAudit } from '../src/audit.js';
import { TenantScopeError, forOrganization, withOrgTransaction } from '../src/tenancy.js';
import type { PrismaClient, TenantTransactionClient } from '../src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;

const acceptedQuoteData = {
  status: 'ACCEPTED' as const,
  incoterm: 'FOB' as const,
  mode: 'SEA_LCL' as const,
  originCountry: 'CN',
  originPort: 'CNSHA',
  destinationPort: 'GBFXT',
  fxRate: '0.790000',
  fxSource: 'HMRC_MONTHLY',
  fxDate: new Date('2026-09-01T00:00:00Z'),
  fxSnapshots: { USD: { rateToGbp: '0.790000', source: 'HMRC_MONTHLY', date: '2026-09-01' } },
  rateSource: 'RATE_SHEET_V1',
  rateFetchedAt: new Date('2026-09-20T00:00:00Z'),
  validUntil: new Date('2026-09-27T00:00:00Z'),
  goodsValueGbp: '790.00',
  freightCost: '300.00',
  freightToBorderGbp: '250.00',
  freightPostBorderGbp: '50.00',
  originFees: '0.00',
  destinationFees: '80.00',
  insurancePremium: '0.00',
  customsValue: '1040.00',
  totalDuty: '83.20',
  totalVat: '240.64',
  vatRecoverable: true,
  platformFee: '0.00',
  totalLandedCost: '1443.84',
  totalLandedCostExVat: '1203.20',
  apportionmentBasis: 'SEA_WEIGHT_OR_MEASURE',
  warnings: [],
  calcVersion: 'test',
  acceptedAt: new Date(),
};

describe.skipIf(!DATABASE_URL)('cross-tenant isolation (database)', () => {
  const orgA = randomUUID();
  const orgB = randomUUID();
  let prisma: PrismaClient;
  let productA: { id: string };
  let productB: { id: string };
  let acceptedQuoteId: string;
  let mustSwitchRole = false;

  /** Superusers/BYPASSRLS roles ignore RLS, so act as the app role for the raw checks. */
  const asAppRole = async (tx: TenantTransactionClient) => {
    if (mustSwitchRole) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
  };

  beforeAll(async () => {
    prisma = createPrismaClient({ databaseUrl: DATABASE_URL!, log: ['error'] });
    const [who] = await prisma.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    mustSwitchRole = who?.bypass === true;

    for (const [org, label] of [
      [orgA, 'A'],
      [orgB, 'B'],
    ] as const) {
      const product = await withOrgTransaction(prisma, org, async (tx) => {
        await tx.organization.create({ data: { name: `cross-tenant test ${label}` } });
        return tx.product.create({
          data: {
            organizationId: org,
            sku: `SKU-${label}`,
            name: `Widget ${label}`,
            hsCode: '6404199000',
            originCountry: 'CN',
            unitValue: '10.0000',
            currency: 'USD',
            weightKg: '0.500',
            volumeCbm: '0.0020',
          },
          select: { id: true },
        });
      });
      if (label === 'A') productA = product;
      else productB = product;
    }

    acceptedQuoteId = await withOrgTransaction(prisma, orgA, async (tx) => {
      const quote = await tx.quote.create({
        data: { ...acceptedQuoteData, organizationId: orgA },
        select: { id: true },
      });
      return quote.id;
    });
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      await withOrgTransaction(prisma, org, async (tx) => {
        // Accepted quotes cannot be deleted; cancelling first is the permitted path.
        await tx.quote.updateMany({ where: { status: 'ACCEPTED' }, data: { status: 'CANCELLED' } });
        await tx.quoteLine.deleteMany();
        await tx.quote.deleteMany();
        await tx.product.deleteMany();
        await tx.organization.deleteMany();
      });
    }
    await disposePrismaClient();
  });

  describe('(a) Prisma tenant scope', () => {
    it('the scoped client for org A cannot see org B product', async () => {
      const a = forOrganization(prisma, orgA);
      // Argument-scoping alone, independent of RLS: B's id is ANDed with A's organizationId.
      expect(await a.product.findMany({ where: { id: productB.id } })).toEqual([]);
      expect(await a.product.findUnique({ where: { id: productB.id } })).toBeNull();
      expect(await a.product.findMany({ where: { organizationId: orgB } })).toEqual([]);

      // With the RLS context set, A sees exactly its own product.
      const ids = await withOrgTransaction(prisma, orgA, async (tx) =>
        (await tx.product.findMany({ select: { id: true } })).map((p) => p.id),
      );
      expect(ids).toEqual([productA.id]);
    });

    it('update/delete of another tenant row fails with TenantScopeError and changes nothing', async () => {
      await expect(
        withOrgTransaction(prisma, orgA, (tx) =>
          tx.product.update({ where: { id: productB.id }, data: { name: 'hijacked' } }),
        ),
      ).rejects.toBeInstanceOf(TenantScopeError);
      await expect(
        withOrgTransaction(prisma, orgA, (tx) => tx.product.delete({ where: { id: productB.id } })),
      ).rejects.toBeInstanceOf(TenantScopeError);

      const b = await withOrgTransaction(prisma, orgB, (tx) =>
        tx.product.findUniqueOrThrow({ where: { id: productB.id }, select: { name: true } }),
      );
      expect(b.name).toBe('Widget B');
    });

    it('create in A cannot be redirected to B', async () => {
      const attempt = withOrgTransaction(prisma, orgA, (tx) =>
        tx.product.create({
          data: {
            organizationId: orgB,
            sku: 'SKU-REDIRECT',
            name: 'x',
            hsCode: '6404199000',
            originCountry: 'CN',
            unitValue: '1.0000',
            currency: 'USD',
            weightKg: '0.100',
            volumeCbm: '0.0010',
          },
          select: { organizationId: true },
        }),
      );
      await expect(attempt).rejects.toBeInstanceOf(TenantScopeError);
      const count = await withOrgTransaction(prisma, orgB, (tx) =>
        tx.product.count({ where: { sku: 'SKU-REDIRECT' } }),
      );
      expect(count).toBe(0);
    });
  });

  describe('(b) Postgres row level security', () => {
    it('a raw SELECT on products inside withOrgTransaction(orgA) only returns A rows', async () => {
      const rows = await withOrgTransaction(prisma, orgA, async (tx) => {
        await asAppRole(tx);
        return tx.$queryRaw<{ id: string; organization_id: string }[]>`
          SELECT id, organization_id FROM products
          WHERE id IN (${productA.id}::uuid, ${productB.id}::uuid)`;
      });
      expect(rows.map((r) => r.id)).toEqual([productA.id]);
      expect(rows.every((r) => r.organization_id === orgA)).toBe(true);
    });

    it('with no tenant context nothing is visible (fail closed)', async () => {
      const [row] = await prisma.$transaction(async (tx) => {
        if (mustSwitchRole) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
        return tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM products WHERE id IN (${productA.id}::uuid, ${productB.id}::uuid)`;
      });
      expect(Number(row?.n)).toBe(0);
    });

    it('a raw INSERT for another tenant is rejected by WITH CHECK', async () => {
      await expect(
        withOrgTransaction(prisma, orgA, async (tx) => {
          await asAppRole(tx);
          await tx.$executeRaw`
            INSERT INTO suppliers (id, organization_id, name, country_code, updated_at)
            VALUES (${randomUUID()}::uuid, ${orgB}::uuid, 'smuggled', 'CN', now())`;
        }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('(c) accepted quotes are immutable', () => {
    it('updating totals raises the trigger error', async () => {
      await expect(
        withOrgTransaction(prisma, orgA, (tx) =>
          tx.quote.update({ where: { id: acceptedQuoteId }, data: { totalDuty: '1.00' } }),
        ),
      ).rejects.toThrow(/ACCEPTED and immutable/);
    });

    it('deleting an accepted quote is rejected', async () => {
      await expect(
        withOrgTransaction(prisma, orgA, (tx) =>
          tx.quote.delete({ where: { id: acceptedQuoteId } }),
        ),
      ).rejects.toThrow(/ACCEPTED and immutable/);
    });

    it('status may not go back to DRAFT', async () => {
      await expect(
        withOrgTransaction(prisma, orgA, (tx) =>
          tx.quote.update({ where: { id: acceptedQuoteId }, data: { status: 'DRAFT' } }),
        ),
      ).rejects.toThrow(/ACCEPTED and immutable/);
    });

    it('adding a line to an accepted quote is rejected', async () => {
      await expect(
        withOrgTransaction(prisma, orgA, (tx) =>
          tx.quoteLine.create({
            data: {
              organizationId: orgA,
              quoteId: acceptedQuoteId,
              productId: productA.id,
              quantity: 1,
              hsCode: '6404199000',
              originCountry: 'CN',
              unitValue: '10.0000',
              currency: 'USD',
              unitValueGbp: '7.9000',
              lineGoodsValueGbp: '7.90',
              lineWeightKg: '0.500',
              lineVolumeCbm: '0.0020',
              chargeableWeight: '0.5000',
              dutyType: 'AD_VALOREM',
              dutyRatePct: '8.0000',
              vatRatePct: '20.00',
              allocatedFreightGbp: '0.00',
              allocatedFreightToBorderGbp: '0.00',
              allocatedFreightPostBorderGbp: '0.00',
              allocatedOriginFeesGbp: '0.00',
              allocatedDestinationFeesGbp: '0.00',
              allocatedInsuranceGbp: '0.00',
              allocatedPlatformFeeGbp: '0.00',
              lineCustomsValueGbp: '7.90',
              lineDutyGbp: '0.63',
              lineVatGbp: '1.71',
              lineLandedCostExVatGbp: '8.53',
              lineLandedCostGbp: '10.24',
              landedCostPerUnit: '8.5300',
              landedCostPerUnitIncVat: '10.2400',
            },
          }),
        ),
      ).rejects.toThrow(/ACCEPTED and immutable/);
    });

    it('a no-op update (only updated_at) is tolerated, then status -> CANCELLED is allowed', async () => {
      await withOrgTransaction(prisma, orgA, (tx) =>
        tx.quote.update({ where: { id: acceptedQuoteId }, data: {} }),
      );
      const cancelled = await withOrgTransaction(prisma, orgA, (tx) =>
        tx.quote.update({
          where: { id: acceptedQuoteId },
          data: { status: 'CANCELLED' },
          select: { status: true },
        }),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  describe('audit log', () => {
    it('recordAudit writes a tenant row and the row is append-only', async () => {
      const id = await withOrgTransaction(prisma, orgA, async (tx) => {
        await recordAudit(tx, {
          organizationId: orgA,
          userId: null,
          action: 'quote.cancel',
          targetType: 'Quote',
          targetId: acceptedQuoteId,
          metadata: { from: 'ACCEPTED', to: 'CANCELLED' },
        });
        const row = await tx.auditLog.findFirstOrThrow({
          where: { action: 'quote.cancel' },
          select: { id: true },
        });
        return row.id;
      });
      // As harbour_app the REVOKE (grant layer) rejects first; as the owner/superuser the trigger does.
      await expect(
        withOrgTransaction(prisma, orgA, (tx) => tx.auditLog.delete({ where: { id } })),
      ).rejects.toThrow(/append-only|permission denied/);
    });

    it('recordAudit writes a tenant-less row (sign-in) under the app role, which cannot read it back', async () => {
      const marker = randomUUID();
      await prisma.$transaction(async (tx) => {
        if (mustSwitchRole) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
        // INSERT ... RETURNING would need SELECT on the new row, which no policy grants for NULL
        // organisations; recordAudit must therefore not use RETURNING.
        await recordAudit(tx, {
          organizationId: null,
          userId: null,
          action: 'auth.sign_in',
          targetType: 'User',
          targetId: marker,
        });
        const visible = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM audit_logs WHERE target_id = ${marker}`;
        expect(Number(visible[0]?.n)).toBe(0);
      });
    });
  });
});
