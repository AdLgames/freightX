/**
 * Migration 0003 against a real Postgres: CustomsProfile row rules, the PVA trigger pair, tenant
 * isolation of customs_profiles, the engine 1.1 quote columns and the accepted-quote trigger.
 *
 * Skipped unless DATABASE_URL is set (see cross-tenant.db.test.ts for the requirements). Superuser
 * connections switch to `SET LOCAL ROLE harbour_app` for the raw RLS checks.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, disposePrismaClient } from '../src/client.js';
import { forOrganization, withOrgTransaction } from '../src/tenancy.js';
import type { Prisma, PrismaClient, TenantTransactionClient } from '../src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;

const quoteData = (overrides: Record<string, unknown> = {}) => ({
  status: 'READY' as const,
  incoterm: 'FOB' as const,
  mode: 'SEA_LCL' as const,
  originCountry: 'CN',
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
  customsValue: '1040.00',
  totalDuty: '83.20',
  totalVat: '240.64',
  vatRecoverable: true,
  platformFee: '0.00',
  totalLandedCost: '1443.84',
  totalLandedCostExVat: '1203.20',
  apportionmentBasis: 'SEA_WEIGHT_OR_MEASURE',
  warnings: [],
  calcVersion: '1.0',
  ...overrides,
});

describe.skipIf(!DATABASE_URL)(
  '0003 customs profiles and engine 1.1 quote columns (database)',
  () => {
    const orgVat = randomUUID(); // VAT-registered, has a VAT number
    const orgNoVat = randomUUID(); // not VAT-registered
    const userId = randomUUID();
    let prisma: PrismaClient;
    let mustSwitchRole = false;
    let ownsQuotes = false;
    let productId: string;

    const asAppRole = async (tx: TenantTransactionClient) => {
      if (mustSwitchRole) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
    };

    beforeAll(async () => {
      prisma = createPrismaClient({ databaseUrl: DATABASE_URL!, log: ['error'] });
      const [who] = await prisma.$queryRaw<{ bypass: boolean; owns: boolean }[]>`
      SELECT (r.rolsuper OR r.rolbypassrls) AS bypass,
             pg_has_role(current_user, (SELECT tableowner FROM pg_tables WHERE tablename = 'quotes'), 'USAGE') AS owns
      FROM pg_roles r WHERE r.rolname = current_user`;
      mustSwitchRole = who?.bypass === true;
      ownsQuotes = who?.owns === true;

      await prisma.user.create({ data: { id: userId, email: `cds-${userId}@example.test` } });
      await withOrgTransaction(prisma, orgVat, (tx) =>
        tx.organization.create({
          data: { name: 'VAT org', vatRegistered: true, vatNumber: 'GB123456789' },
        }),
      );
      await withOrgTransaction(prisma, orgNoVat, (tx) =>
        tx.organization.create({ data: { name: 'no-VAT org' } }),
      );
      productId = await withOrgTransaction(prisma, orgVat, async (tx) => {
        const p = await tx.product.create({
          data: {
            organizationId: orgVat,
            sku: 'SKU-0003',
            name: 'Widget',
            hsCode: '6404199000',
            originCountry: 'CN',
            unitValue: '10.0000',
            currency: 'USD',
            weightKg: '0.500',
            volumeCbm: '0.0020',
          },
          select: { id: true },
        });
        return p.id;
      });
    });

    afterAll(async () => {
      for (const org of [orgVat, orgNoVat]) {
        await withOrgTransaction(prisma, org, async (tx) => {
          await tx.customsProfile.deleteMany();
          await tx.quote.updateMany({
            where: { status: 'ACCEPTED' },
            data: { status: 'CANCELLED' },
          });
          await tx.quoteLine.deleteMany();
          await tx.quote.deleteMany();
          await tx.product.deleteMany();
          await tx.organization.deleteMany();
        });
      }
      await prisma.user.deleteMany({ where: { id: userId } });
      await disposePrismaClient();
    });

    const createProfile = (org: string, data: Record<string, unknown>) =>
      withOrgTransaction(prisma, org, (tx) =>
        tx.customsProfile.create({ data: { organizationId: org, ...data } }),
      );

    describe('CHECK constraints', () => {
      it.each([
        ['DAN not 7 digits', { danNumber: '123456' }, /customs_profiles_dan_number_format/],
        ['DAN not numeric', { danNumber: '12345A7' }, /customs_profiles_dan_number_format/],
        [
          'OWN_DEFERMENT without DAN',
          { paymentMethod: 'OWN_DEFERMENT' },
          /own_deferment_needs_dan/,
        ],
        ['fee pct above 100', { brokerDefermentFeePct: '100.01' }, /broker_fee_pct_range/],
        ['negative fee pct', { brokerDefermentFeePct: '-0.01' }, /broker_fee_pct_range/],
        ['negative minimum', { brokerDefermentMinimumGbp: '-1.00' }, /broker_minimum_nonnegative/],
        ['negative DAN limit', { danLimit: '-1.00' }, /dan_limit_nonnegative/],
        [
          'CDS authority granted without confirmation time',
          { cdsAuthorityGranted: true },
          /cds_authority_confirmed/,
        ],
      ])('rejects %s', async (_label, data, constraint) => {
        await expect(createProfile(orgNoVat, data)).rejects.toThrow(constraint);
      });

      it('accepts a complete OWN_DEFERMENT profile with confirmed CDS authority, and defaults', async () => {
        const confirmedAt = new Date('2026-09-23T09:00:00Z');
        const created = await createProfile(orgVat, {
          paymentMethod: 'OWN_DEFERMENT',
          danNumber: '1234567',
          danLimit: '25000.00',
          cdsAuthorityGranted: true,
          cdsAuthorityConfirmedAt: confirmedAt,
          cdsAuthorityConfirmedById: userId,
          brokerDefermentFeePct: '2.50',
          brokerDefermentMinimumGbp: '15.00',
        });
        expect(created.usePva).toBe(false);
        expect(created.danLimit?.toFixed(2)).toBe('25000.00');
        expect(created.brokerDefermentFeePct?.toFixed(2)).toBe('2.50');
        expect(created.cdsAuthorityConfirmedAt?.toISOString()).toBe(confirmedAt.toISOString());

        const defaults = await createProfile(orgNoVat, {});
        expect(defaults.paymentMethod).toBe('BROKER_DEFERMENT');
        expect(defaults.brokerDefermentFeePct).toBeNull();
        await withOrgTransaction(prisma, orgNoVat, (tx) => tx.customsProfile.deleteMany());
      });

      it('one profile per organisation', async () => {
        await expect(createProfile(orgVat, {})).rejects.toThrow(/Unique constraint/);
      });
    });

    describe('PVA requires VAT registration (trigger pair)', () => {
      it('rejects use_pva for an organisation that is not VAT-registered', async () => {
        await expect(createProfile(orgNoVat, { usePva: true })).rejects.toThrow(
          /postponed VAT accounting requires a VAT-registered organisation/,
        );
      });

      it('rejects use_pva when VAT-registered but without a VAT number', async () => {
        await withOrgTransaction(prisma, orgNoVat, (tx) =>
          tx.organization.update({ where: { id: orgNoVat }, data: { vatRegistered: true } }),
        );
        await expect(createProfile(orgNoVat, { usePva: true })).rejects.toThrow(
          /requires a VAT-registered organisation/,
        );
      });

      it('allows use_pva once the organisation is VAT-registered with a number (insert and update)', async () => {
        const updated = await withOrgTransaction(prisma, orgVat, (tx) =>
          tx.customsProfile.update({
            where: { organizationId: orgVat },
            data: { usePva: true },
            select: { usePva: true },
          }),
        );
        expect(updated.usePva).toBe(true);

        await withOrgTransaction(prisma, orgNoVat, (tx) =>
          tx.organization.update({ where: { id: orgNoVat }, data: { vatNumber: 'GB987654321' } }),
        );
        const created = await createProfile(orgNoVat, { usePva: true });
        expect(created.usePva).toBe(true);
      });

      it('an organisation using PVA cannot drop its VAT registration until PVA is off', async () => {
        await expect(
          withOrgTransaction(prisma, orgNoVat, (tx) =>
            tx.organization.update({ where: { id: orgNoVat }, data: { vatRegistered: false } }),
          ),
        ).rejects.toThrow(/uses postponed VAT accounting/);
        await expect(
          withOrgTransaction(prisma, orgNoVat, (tx) =>
            tx.organization.update({ where: { id: orgNoVat }, data: { vatNumber: null } }),
          ),
        ).rejects.toThrow(/uses postponed VAT accounting/);

        await withOrgTransaction(prisma, orgNoVat, async (tx) => {
          await tx.customsProfile.update({
            where: { organizationId: orgNoVat },
            data: { usePva: false },
          });
          await tx.organization.update({
            where: { id: orgNoVat },
            data: { vatRegistered: false, vatNumber: null },
          });
        });
      });
    });

    describe('tenant isolation of customs_profiles', () => {
      it('the scoped client for one org cannot see or change the other org profile', async () => {
        const a = forOrganization(prisma, orgVat);
        expect(await a.customsProfile.findMany({ where: { organizationId: orgNoVat } })).toEqual(
          [],
        );

        const visible = await withOrgTransaction(prisma, orgVat, (tx) =>
          tx.customsProfile.findMany({ select: { organizationId: true } }),
        );
        expect(visible).toEqual([{ organizationId: orgVat }]);

        await expect(
          withOrgTransaction(prisma, orgVat, (tx) =>
            tx.customsProfile.update({
              where: { organizationId: orgNoVat },
              data: { danLimit: '1.00' },
            }),
          ),
        ).rejects.toThrow(/no row matched within the current organization/);
      });

      it('RLS: raw SELECT returns only the current org, no context returns nothing', async () => {
        const rows = await withOrgTransaction(prisma, orgVat, async (tx) => {
          await asAppRole(tx);
          return tx.$queryRaw<{ organization_id: string }[]>`
          SELECT organization_id FROM customs_profiles
          WHERE organization_id IN (${orgVat}::uuid, ${orgNoVat}::uuid)`;
        });
        expect(rows.map((r) => r.organization_id)).toEqual([orgVat]);

        const [none] = await prisma.$transaction(async (tx) => {
          if (mustSwitchRole) await tx.$executeRawUnsafe('SET LOCAL ROLE harbour_app');
          return tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*)::bigint AS n FROM customs_profiles
          WHERE organization_id IN (${orgVat}::uuid, ${orgNoVat}::uuid)`;
        });
        expect(Number(none?.n)).toBe(0);
      });

      it('RLS: raw INSERT for another tenant is rejected by WITH CHECK', async () => {
        await expect(
          withOrgTransaction(prisma, orgVat, async (tx) => {
            await asAppRole(tx);
            await tx.$executeRaw`
            INSERT INTO customs_profiles (id, organization_id, updated_at)
            VALUES (${randomUUID()}::uuid, ${orgNoVat}::uuid, now())`;
          }),
        ).rejects.toThrow(/row-level security/);
      });
    });

    describe('engine 1.1 quote columns', () => {
      const lineData = (quoteId: string, overrides: Record<string, unknown> = {}) => ({
        organizationId: orgVat,
        quoteId,
        productId,
        quantity: 100,
        hsCode: '6404199000',
        originCountry: 'CN',
        unitValue: '10.0000',
        currency: 'USD',
        unitValueGbp: '7.9000',
        lineGoodsValueGbp: '790.00',
        lineWeightKg: '50.000',
        lineVolumeCbm: '0.2000',
        chargeableWeight: '0.2000',
        dutyType: 'AD_VALOREM',
        dutyRatePct: '8.0000',
        vatRatePct: '20.00',
        allocatedFreightGbp: '300.00',
        allocatedFreightToBorderGbp: '250.00',
        allocatedFreightPostBorderGbp: '50.00',
        allocatedOriginFeesGbp: '0.00',
        allocatedDestinationFeesGbp: '80.00',
        allocatedInsuranceGbp: '0.00',
        allocatedPlatformFeeGbp: '0.00',
        lineCustomsValueGbp: '1040.00',
        lineDutyGbp: '83.20',
        lineVatGbp: '240.64',
        lineLandedCostExVatGbp: '1203.20',
        lineLandedCostGbp: '1443.84',
        landedCostPerUnit: '12.0320',
        landedCostPerUnitIncVat: '14.4384',
        ...overrides,
      });

      it('round-trip the new quote and line columns', async () => {
        const got = await withOrgTransaction(prisma, orgVat, async (tx) => {
          const q = await tx.quote.create({
            data: {
              ...quoteData({
                calcVersion: '1.1',
                vatPostponed: true,
                borderOutlay: '83.20',
                assistsGbp: '120.00',
                financingFee: '15.00',
                inlandVatAdjustment: '45.50',
                paymentMethod: 'BROKER_DEFERMENT',
              }),
              organizationId: orgVat,
            },
            select: { id: true },
          });
          await tx.quoteLine.create({
            data: lineData(q.id, {
              assistsGbp: '120.00',
              allocatedFinancingFeeGbp: '15.00',
              allocatedInlandVatAdjustmentGbp: '45.50',
            }),
          });
          return tx.quote.findUniqueOrThrow({ where: { id: q.id }, include: { lines: true } });
        });
        expect(got.vatPostponed).toBe(true);
        expect(got.paymentMethod).toBe('BROKER_DEFERMENT');
        expect(
          [got.borderOutlay, got.assistsGbp, got.financingFee, got.inlandVatAdjustment].map((d) =>
            d.toFixed(2),
          ),
        ).toEqual(['83.20', '120.00', '15.00', '45.50']);
        const [line] = got.lines;
        expect(
          [
            line!.assistsGbp,
            line!.allocatedFinancingFeeGbp,
            line!.allocatedInlandVatAdjustmentGbp,
          ].map((d) => d.toFixed(2)),
        ).toEqual(['120.00', '15.00', '45.50']);
      });

      it('a quote written without the 1.1 fields reads the additive defaults', async () => {
        const q = await withOrgTransaction(prisma, orgVat, (tx) =>
          tx.quote.create({ data: { ...quoteData(), organizationId: orgVat } }),
        );
        expect(q.vatPostponed).toBe(false);
        expect(q.paymentMethod).toBeNull();
        expect(
          [q.borderOutlay, q.assistsGbp, q.financingFee, q.inlandVatAdjustment].map(String),
        ).toEqual(['0', '0', '0', '0']);
      });
    });

    describe('accepted-quote immutability covers the new columns', () => {
      let acceptedId: string;

      beforeAll(async () => {
        // Written with only the pre-0003 columns, like a quote accepted before the migration.
        acceptedId = await withOrgTransaction(prisma, orgVat, async (tx) => {
          const q = await tx.quote.create({
            data: {
              ...quoteData({ status: 'ACCEPTED', acceptedAt: new Date() }),
              organizationId: orgVat,
            },
            select: { id: true },
          });
          return q.id;
        });
      });

      it.each<[string, Prisma.QuoteUncheckedUpdateInput, RegExp]>([
        ['vatPostponed', { vatPostponed: true }, /changed columns: vat_postponed/],
        ['borderOutlay', { borderOutlay: '1.00' }, /changed columns: border_outlay/],
        ['paymentMethod', { paymentMethod: 'OWN_DEFERMENT' }, /changed columns: payment_method/],
      ])('changing %s on an accepted quote is rejected', async (_label, data, message) => {
        await expect(
          withOrgTransaction(prisma, orgVat, (tx) =>
            tx.quote.update({ where: { id: acceptedId }, data }),
          ),
        ).rejects.toThrow(message);
      });

      it('adding a column with a default (DDL) leaves accepted quotes cancellable and protects the new column', async (ctx) => {
        // ALTER TABLE needs table ownership; a harbour_app login cannot run it. The same check is
        // covered for a real 0002 → 0003 upgrade in the README ("Migrations").
        if (!ownsQuotes) ctx.skip();
        const Rollback = new Error('rollback');
        const outcome: { probeRejected?: boolean; status?: string | undefined } = {};
        await expect(
          withOrgTransaction(prisma, orgVat, async (tx) => {
            await tx.$executeRawUnsafe(
              'ALTER TABLE quotes ADD COLUMN zz_probe_0003 integer NOT NULL DEFAULT 0',
            );
            await tx.$executeRawUnsafe('SAVEPOINT probe');
            try {
              await tx.$executeRaw`UPDATE quotes SET zz_probe_0003 = 1 WHERE id = ${acceptedId}::uuid`;
              outcome.probeRejected = false;
            } catch (err) {
              outcome.probeRejected = /changed columns: zz_probe_0003/.test(String(err));
              await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT probe');
            }
            const [row] = await tx.$queryRaw<{ status: string }[]>`
            UPDATE quotes SET status = 'CANCELLED', updated_at = now()
            WHERE id = ${acceptedId}::uuid RETURNING status::text AS status`;
            outcome.status = row?.status;
            throw Rollback; // undo the DDL and the cancel
          }),
        ).rejects.toBe(Rollback);
        expect(outcome).toEqual({ probeRejected: true, status: 'CANCELLED' });
      });

      it('status -> CANCELLED is still allowed after 0003', async () => {
        const q = await withOrgTransaction(prisma, orgVat, (tx) =>
          tx.quote.update({
            where: { id: acceptedId },
            data: { status: 'CANCELLED' },
            select: { status: true, vatPostponed: true },
          }),
        );
        expect(q).toEqual({ status: 'CANCELLED', vatPostponed: false });
      });
    });
  },
);
