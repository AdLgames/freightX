/**
 * Settings (M2) against a real Postgres: organisation identity (encrypted EORI/VAT), the customs
 * profile wizard, company lookup, members and invitations, the audit log, and the tenancy and
 * PII rules around them (brief §5.6, §7.2, §7.3, §9). Runs only with DATABASE_URL (migrations
 * applied); works as a superuser or as a non-superuser member of harbour_app.
 */
import { randomUUID } from 'node:crypto';
import { CompaniesHouseClient, type FetchLike } from '@harbour/adapters';
import {
  CIPHERTEXT_RE,
  decryptField,
  disposePrismaClient,
  prismaDataKeyStore,
  withOrgTransaction,
  type PrismaClient,
} from '@harbour/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAppForTests } from '../services/app.server';
import { listUserOrganizations } from '../services/organizations.server';
import { pageErrorSchema } from '../services/page-error';
import { createInvitation, lookupInvitation } from '../services/settings/invitations.server';
import type { MemoryJobEnqueuer } from '../services/settings/jobs.server';
import { changeMemberRole, removeMember } from '../services/settings/members.server';
import {
  createTestApp,
  lastLinkPath,
  makeRequest,
  run,
  sessionCookieFrom,
  sessionIdFrom,
  uniqueEmail,
  type TestApp,
} from '../test-support/harness';
import { loader as homeLoader } from './app._index';
import { loader as auditLoader } from './app.settings.audit';
import { action as customsAction, loader as customsLoader } from './app.settings.customs';
import { action as membersAction, loader as membersLoader } from './app.settings.members';
import { action as orgAction, loader as orgLoader } from './app.settings.organisation';
import { action as inviteAction, loader as inviteLoader } from './invite.accept';
import { action as loginAction } from './login';
import { action as verifyAction } from './login_.verify';
import { action as onboardingAction, loader as onboardingLoader } from './onboarding.organization';

const DATABASE_URL = process.env.DATABASE_URL;

const EORI = 'GB123456789000';
const VAT = 'GB123456782';
const DAN = '7654321';

interface Actor {
  email: string;
  cookie: string;
  userId: string;
}

describe.skipIf(!DATABASE_URL)('settings (database)', () => {
  let t: TestApp;
  let prisma: PrismaClient;
  const emails: string[] = [];
  const orgIds: string[] = [];
  let owner: Actor;
  let orgId: string;
  let firstLog = 0;

  const newEmail = (label: string) => {
    const e = uniqueEmail(label);
    emails.push(e);
    return e;
  };

  /** Full magic-link sign-in; returns the session cookie (and follows `next`). */
  const signIn = async (email: string, next?: string): Promise<Actor> => {
    const sent = await run(
      loginAction,
      makeRequest('/login', {
        form: { email, ...(next ? { next } : {}) },
        headers: { 'x-forwarded-for': `203.0.113.${emails.length % 250}` },
      }),
    );
    expect(sent.data).toMatchObject({ status: 'sent' });
    const link = new URL(lastLinkPath(t.logs)!, 'http://x');
    const token = link.searchParams.get('token')!;
    const res = await run(
      verifyAction,
      makeRequest('/login/verify', {
        form: { token, ...(next ? { next: link.searchParams.get('next') ?? next } : {}) },
      }),
    );
    expect(res.status).toBe(302);
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    return { email, cookie: sessionCookieFrom(res.setCookie)!, userId: user.id };
  };

  const csrfFor = async (cookie: string) =>
    (await t.app.auth.sessions!.read(sessionIdFrom(cookie)))!.data.csrfToken;

  /** POST a settings form as `actor` with a valid CSRF token. */
  const post = async (fn: unknown, path: string, actor: Actor, form: Record<string, string>) =>
    run(
      fn,
      makeRequest(path, {
        cookie: actor.cookie,
        form: { ...form, _csrf: await csrfFor(actor.cookie) },
      }),
    );

  const orgRow = () =>
    withOrgTransaction(prisma, orgId, (tx) =>
      tx.organization.findUniqueOrThrow({ where: { id: orgId } }),
    );

  const audits = () =>
    withOrgTransaction(prisma, orgId, (tx) =>
      tx.auditLog.findMany({ orderBy: { createdAt: 'asc' } }),
    );

  beforeAll(async () => {
    t = await createTestApp({ databaseUrl: DATABASE_URL });
    prisma = t.prisma!;
    firstLog = t.logs.length;
    owner = await signIn(newEmail('owner'));
    const page = await run(
      onboardingLoader,
      makeRequest('/onboarding/organization', { cookie: owner.cookie }),
    );
    const created = await run(
      onboardingAction,
      makeRequest('/onboarding/organization', {
        cookie: owner.cookie,
        form: { name: 'Hydro Imports Ltd', _csrf: (page.data as { csrfToken: string }).csrfToken },
      }),
    );
    owner.cookie = sessionCookieFrom(created.setCookie)!;
    orgId = (await listUserOrganizations(prisma, owner.userId))[0]!.organization.id;
    orgIds.push(orgId);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await withOrgTransaction(prisma, id, async (tx) => {
        await tx.invitation.deleteMany();
        await tx.customsProfile.deleteMany();
        await tx.membership.deleteMany();
        await tx.organization.deleteMany();
      });
    }
    await prisma.magicLinkToken.deleteMany({ where: { email: { in: emails } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    setAppForTests(null);
    await disposePrismaClient();
  });

  describe('organisation identity', () => {
    it('the overview and organisation pages load with nothing set', async () => {
      const page = await run(
        orgLoader,
        makeRequest('/app/settings/organisation', { cookie: owner.cookie }),
      );
      expect(page.status).toBe(200);
      expect(page.data).toMatchObject({
        org: { name: 'Hydro Imports Ltd', baseCurrency: 'GBP' },
        identity: {
          eori: { set: false, last4: null, status: 'UNVERIFIED' },
          vat: { set: false, registered: false, status: 'UNVERIFIED' },
        },
        company: { checkedAt: null },
        canEdit: true,
        companyLookupEnabled: false,
      });
    });

    it('rejects a malformed EORI with a field message and a cross-site POST', async () => {
      const bad = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'eori',
        eoriNumber: 'GB1',
      });
      expect(bad.status).toBe(400);
      expect(bad.data).toMatchObject({
        errors: { eoriNumber: 'EORI must be GB or XI followed by 12 digits.' },
      });
      const noCsrf = await run(
        orgAction,
        makeRequest('/app/settings/organisation', {
          cookie: owner.cookie,
          form: { intent: 'eori', eoriNumber: EORI },
        }),
      );
      expect(noCsrf.status).toBe(403);
    });

    it('stores the EORI as ciphertext with last4, status PENDING, an audit row and a queued job', async () => {
      const res = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'eori',
        eoriNumber: ' gb 1234 5678 9000 ',
      });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ ok: true, intent: 'eori' });

      const org = await orgRow();
      expect(org.eoriNumber).toMatch(CIPHERTEXT_RE);
      expect(org.eoriNumber).not.toContain(EORI);
      expect(org.eoriNumber).not.toContain('9000');
      expect(org.eoriLast4).toBe('9000');
      expect(org.eoriVerificationStatus).toBe('PENDING');
      expect(org.eoriVerifiedAt).toBeNull();
      expect(org.dataKeyCiphertext).toMatch(CIPHERTEXT_RE);
      // The raw column, read without Prisma, holds no plaintext either.
      const raw = await withOrgTransaction(
        prisma,
        orgId,
        (tx) =>
          tx.$queryRaw<
            { eori_number: string }[]
          >`SELECT eori_number FROM organizations WHERE id = ${orgId}::uuid`,
      );
      expect(raw[0]!.eori_number).not.toContain('123456789');

      // Decrypting with the app's key provider gives the plaintext back.
      const dataKey = await t.app.settings.keyProvider!.unwrapDataKey(org.dataKeyCiphertext!);
      expect(decryptField(dataKey, orgId, 'eoriNumber', org.eoriNumber!)).toBe(EORI);
      // …and the prismaDataKeyStore reads the same wrapped key.
      expect(
        await withOrgTransaction(prisma, orgId, (tx) => prismaDataKeyStore(tx).read(orgId)),
      ).toBe(org.dataKeyCiphertext);

      const jobs = t.app.settings.jobs as MemoryJobEnqueuer;
      expect(jobs.enqueued).toEqual([{ queue: 'eori-verify', payload: { organizationId: orgId } }]);

      const rows = await audits();
      const audit = rows.find((a) => a.action === 'org.eori.update')!;
      expect(audit.userId).toBe(owner.userId);
      expect(audit.metadata).toEqual({ eoriLast4: '9000' });
      expect(JSON.stringify(rows)).not.toContain(EORI);

      const page = await run(
        orgLoader,
        makeRequest('/app/settings/organisation', { cookie: owner.cookie }),
      );
      expect((page.data as { identity: { eori: unknown } }).identity.eori).toMatchObject({
        set: true,
        last4: '9000',
        status: 'PENDING',
      });
      // The loader never returns the number itself.
      expect(JSON.stringify(page.data)).not.toContain(EORI);

      // Saving the same number again changes nothing and queues nothing.
      const again = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'eori',
        eoriNumber: EORI,
      });
      expect(again.data).toMatchObject({ ok: true, message: 'Nothing changed.' });
      expect(jobs.enqueued).toHaveLength(1);
      expect((await audits()).filter((a) => a.action === 'org.eori.update')).toHaveLength(1);
    });

    it('MEMBER and VIEWER cannot change tax ids (403), even with a valid CSRF token', async () => {
      const viewer = await signIn(newEmail('viewer'));
      await withOrgTransaction(prisma, orgId, (tx) =>
        tx.membership.create({
          data: { organizationId: orgId, userId: viewer.userId, role: 'VIEWER' },
        }),
      );
      // First request rotates the session onto the new membership.
      const first = await run(
        orgLoader,
        makeRequest('/app/settings/organisation', { cookie: viewer.cookie }),
      );
      viewer.cookie = sessionCookieFrom(first.setCookie) ?? viewer.cookie;
      const page = await run(
        orgLoader,
        makeRequest('/app/settings/organisation', { cookie: viewer.cookie }),
      );
      expect(page.status).toBe(200);
      expect(page.data).toMatchObject({ canEdit: false, canConfirmCompany: false });

      for (const form of [
        { intent: 'eori', eoriNumber: 'GB999999999999' },
        { intent: 'vat', vatRegistered: 'yes', vatNumber: VAT },
        { intent: 'details', name: 'Hacked Ltd', baseCurrency: 'USD' },
        { intent: 'company.unincorporated' },
      ]) {
        const res = await post(orgAction, '/app/settings/organisation', viewer, form);
        expect(res.status, form.intent).toBe(403);
        expect(pageErrorSchema.safeParse(res.data).success).toBe(true);
      }
      const customs = await post(customsAction, '/app/settings/customs', viewer, {
        paymentMethod: 'CDS_CASH_ACCOUNT',
      });
      expect(customs.status).toBe(403);
      const members = await post(membersAction, '/app/settings/members', viewer, {
        intent: 'invite',
        email: newEmail('x'),
        role: 'OWNER',
      });
      expect(members.status).toBe(403);
      const audit = await run(
        auditLoader,
        makeRequest('/app/settings/audit', { cookie: viewer.cookie }),
      );
      expect(audit.status).toBe(403);
      expect((await orgRow()).eoriLast4).toBe('9000');
      // Viewer keeps read access to the members list.
      const list = await run(
        membersLoader,
        makeRequest('/app/settings/members', { cookie: viewer.cookie }),
      );
      expect(list.status).toBe(200);
      expect(list.data).toMatchObject({ canManage: false, invitations: [] });
      // Clean up: remove the viewer so later member tests start from a known list.
      await withOrgTransaction(prisma, orgId, (tx) =>
        tx.membership.deleteMany({ where: { userId: viewer.userId } }),
      );
    });
  });

  describe('customs profile', () => {
    it('PVA without a VAT registration is a friendly field error, not a failed request', async () => {
      const res = await post(customsAction, '/app/settings/customs', owner, {
        usePva: 'on',
        paymentMethod: 'BROKER_DEFERMENT',
      });
      expect(res.status).toBe(400);
      expect(res.data).toMatchObject({
        ok: false,
        errors: { usePva: expect.stringContaining('VAT-registered') },
      });
      const profile = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.customsProfile.findFirstOrThrow(),
      );
      expect(profile.usePva).toBe(false);
    });

    it('the database trigger is still the backstop for PVA', async () => {
      await expect(
        withOrgTransaction(prisma, orgId, (tx) =>
          tx.customsProfile.updateMany({ data: { usePva: true } }),
        ),
      ).rejects.toThrow(/postponed VAT accounting requires a VAT-registered/);
    });

    it('VAT number saved encrypted; then PVA can be turned on; then the VAT registration cannot be cleared', async () => {
      const missing = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'vat',
        vatRegistered: 'yes',
        vatNumber: '',
      });
      expect(missing.status).toBe(400);
      expect(missing.data).toMatchObject({
        errors: { vatNumber: expect.stringContaining('VAT registration number') },
      });

      const saved = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'vat',
        vatRegistered: 'yes',
        vatNumber: 'gb 123 4567 82',
      });
      expect(saved.status).toBe(200);
      let org = await orgRow();
      expect(org.vatRegistered).toBe(true);
      expect(org.vatNumber).toMatch(CIPHERTEXT_RE);
      expect(org.vatNumber).not.toContain('123456782');
      expect(org.vatLast4).toBe('6782');
      expect(org.vatVerificationStatus).toBe('PENDING');
      expect((t.app.settings.jobs as MemoryJobEnqueuer).enqueued.map((j) => j.queue)).toEqual([
        'eori-verify',
        'vat-verify',
      ]);
      const vatAudit = (await audits()).find((a) => a.action === 'org.vat.update')!;
      expect(vatAudit.metadata).toEqual({ vatRegistered: true, vatLast4: '6782' });

      // Blank number while registered keeps the stored one.
      const keep = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'vat',
        vatRegistered: 'yes',
        vatNumber: '',
      });
      expect(keep.data).toMatchObject({ ok: true, message: 'Nothing changed.' });

      const pva = await post(customsAction, '/app/settings/customs', owner, {
        usePva: 'on',
        paymentMethod: 'BROKER_DEFERMENT',
        brokerDefermentFeePct: '2.5',
        brokerDefermentMinimumGbp: '25',
      });
      expect(pva.status).toBe(200);
      const profile = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.customsProfile.findFirstOrThrow(),
      );
      expect(profile.usePva).toBe(true);
      expect(profile.brokerDefermentFeePct?.toString()).toBe('2.5');
      expect(profile.brokerDefermentMinimumGbp?.toString()).toBe('25');
      const page = await run(
        customsLoader,
        makeRequest('/app/settings/customs', { cookie: owner.cookie }),
      );
      expect(page.data).toMatchObject({
        profile: {
          usePva: true,
          paymentMethod: 'BROKER_DEFERMENT',
          vatRegistered: true,
          vatNumberSet: true,
        },
        forwarder: { eori: null, name: null },
      });

      // Now the VAT registration is locked by the profile (pre-check and trigger agree).
      const clear = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'vat',
        vatRegistered: 'no',
      });
      expect(clear.status).toBe(400);
      expect(clear.data).toMatchObject({
        errors: { vatRegistered: expect.stringContaining('postponed VAT accounting') },
      });
      org = await orgRow();
      expect(org.vatRegistered).toBe(true);
      await expect(
        withOrgTransaction(prisma, orgId, (tx) =>
          tx.organization.update({ where: { id: orgId }, data: { vatNumber: null } }),
        ),
      ).rejects.toThrow(/uses postponed VAT accounting/);
    });

    it('own deferment needs a DAN and the CDS confirmation; the DAN never reaches the audit log', async () => {
      const noDan = await post(customsAction, '/app/settings/customs', owner, {
        usePva: 'on',
        paymentMethod: 'OWN_DEFERMENT',
      });
      expect(noDan.status).toBe(400);
      expect(noDan.data).toMatchObject({ errors: { danNumber: expect.stringContaining('DAN') } });

      const notConfirmed = await post(customsAction, '/app/settings/customs', owner, {
        usePva: 'on',
        paymentMethod: 'OWN_DEFERMENT',
        danNumber: DAN,
      });
      expect(notConfirmed.status).toBe(200);
      let profile = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.customsProfile.findFirstOrThrow(),
      );
      expect(profile).toMatchObject({
        paymentMethod: 'OWN_DEFERMENT',
        danNumber: DAN,
        cdsAuthorityGranted: false,
        cdsAuthorityConfirmedAt: null,
        brokerDefermentFeePct: null, // fee terms cleared: not broker deferment
      });
      const home = await run(homeLoader, makeRequest('/app', { cookie: owner.cookie }));
      expect((home.data as { actions: Array<{ id: string }> }).actions.map((a) => a.id)).toEqual([
        'cds_authority_missing',
      ]);

      const confirmed = await post(customsAction, '/app/settings/customs', owner, {
        usePva: 'on',
        paymentMethod: 'OWN_DEFERMENT',
        danNumber: DAN,
        cdsAuthorityConfirmed: 'on',
      });
      expect(confirmed.status).toBe(200);
      profile = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.customsProfile.findFirstOrThrow(),
      );
      expect(profile.cdsAuthorityGranted).toBe(true);
      expect(profile.cdsAuthorityConfirmedAt).not.toBeNull();
      expect(profile.cdsAuthorityConfirmedById).toBe(owner.userId);
      const rows = await audits();
      expect(rows.map((a) => a.action)).toContain('org.cds_authority.confirm');
      expect(
        rows.filter((a) => a.action === 'org.customs_profile.update').at(-1)!.metadata,
      ).toEqual({
        usePva: true,
        paymentMethod: 'OWN_DEFERMENT',
        danSet: true,
        feeTermsSet: false,
        cdsAuthorityGranted: true,
      });
      expect(JSON.stringify(rows)).not.toContain(DAN);
      expect(
        (await run(homeLoader, makeRequest('/app', { cookie: owner.cookie }))).data,
      ).toMatchObject({ actions: [] });

      // Switching away drops the authority; the DAN format CHECK is the backstop for raw writes.
      const back = await post(customsAction, '/app/settings/customs', owner, {
        usePva: 'on',
        paymentMethod: 'CDS_CASH_ACCOUNT',
      });
      expect(back.status).toBe(200);
      profile = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.customsProfile.findFirstOrThrow(),
      );
      expect(profile).toMatchObject({
        paymentMethod: 'CDS_CASH_ACCOUNT',
        cdsAuthorityGranted: false,
        danNumber: null,
      });
    });
  });

  describe('company lookup', () => {
    it('searches, confirms a match re-read from the API, records it, and audits the number only', async () => {
      const fetch: FetchLike = async (url) => {
        const body = url.includes('/search/companies')
          ? {
              items: [
                {
                  company_number: '12345678',
                  title: 'HYDRO IMPORTS LTD',
                  company_status: 'active',
                  company_type: 'ltd',
                },
              ],
            }
          : url.endsWith('/company/12345678')
            ? {
                company_number: '12345678',
                company_name: 'HYDRO IMPORTS LTD',
                company_status: 'active',
                type: 'ltd',
              }
            : null;
        return {
          ok: body !== null,
          status: body === null ? 404 : 200,
          text: async () => '',
          json: async () => body,
        };
      };
      t.app.settings.companiesHouse = new CompaniesHouseClient({
        apiKey: 'k',
        baseUrl: 'https://ch.test',
        fetch,
      });

      const search = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'company.search',
        query: 'Hydro Imports',
      });
      expect(search.status).toBe(200);
      expect(search.data).toMatchObject({
        matches: [
          { companyNumber: '12345678', name: 'HYDRO IMPORTS LTD', status: 'active', type: 'ltd' },
        ],
      });
      const wrong = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'company.confirm',
        companyNumber: '00000000',
      });
      expect(wrong.status).toBe(400);
      const confirm = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'company.confirm',
        companyNumber: '12345678',
      });
      expect(confirm.status).toBe(200);
      const org = await orgRow();
      expect(org).toMatchObject({
        companiesHouseNumber: '12345678',
        companiesHouseStatus: 'active',
        companyType: 'ltd',
        companiesHouseName: 'HYDRO IMPORTS LTD',
      });
      expect(org.companiesHouseCheckedAt).not.toBeNull();
      const page = await run(
        orgLoader,
        makeRequest('/app/settings/organisation', { cookie: owner.cookie }),
      );
      expect((page.data as { company: unknown }).company).toMatchObject({
        financeEligible: true,
        unincorporated: false,
      });
      const audit = (await audits()).find((a) => a.action === 'org.company.confirm')!;
      expect(audit.metadata).toEqual({
        companyNumber: '12345678',
        status: 'active',
        type: 'ltd',
        unincorporated: false,
      });
      expect(JSON.stringify(audit)).not.toContain('HYDRO');

      const sole = await post(orgAction, '/app/settings/organisation', owner, {
        intent: 'company.unincorporated',
      });
      expect(sole.status).toBe(200);
      expect(await orgRow()).toMatchObject({
        companiesHouseNumber: null,
        companyType: null,
        companiesHouseName: null,
      });
      t.app.settings.companiesHouse = null;
    });
  });

  describe('members and invitations', () => {
    let invitee: Actor;
    let inviteePath: string;

    it('invites by email (ADMIN cannot grant OWNER) and lists the pending invitation', async () => {
      const inviteeEmail = newEmail('invitee');
      const res = await post(membersAction, '/app/settings/members', owner, {
        intent: 'invite',
        email: inviteeEmail.toUpperCase(),
        role: 'MEMBER',
      });
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ ok: true, message: 'Invitation sent.' });
      inviteePath = lastLinkPath(t.logs)!;
      expect(inviteePath).toMatch(/^\/invite\/accept\?token=/);

      const dupe = await post(membersAction, '/app/settings/members', owner, {
        intent: 'invite',
        email: inviteeEmail,
        role: 'MEMBER',
      });
      expect(dupe.status).toBe(400);
      expect(dupe.data).toMatchObject({ message: expect.stringContaining('pending invitation') });
      const self = await post(membersAction, '/app/settings/members', owner, {
        intent: 'invite',
        email: owner.email,
        role: 'MEMBER',
      });
      expect(self.data).toMatchObject({ message: expect.stringContaining('already a member') });

      const list = await run(
        membersLoader,
        makeRequest('/app/settings/members', { cookie: owner.cookie }),
      );
      expect(list.data).toMatchObject({
        canManage: true,
        assignableRoles: ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'],
        invitations: [{ email: inviteeEmail.toLowerCase(), role: 'MEMBER', expired: false }],
      });
      const row = await withOrgTransaction(prisma, orgId, (tx) => tx.invitation.findFirstOrThrow());
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(inviteePath).not.toContain(row.tokenHash);
      expect(row.emailHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
      const audit = (await audits()).find((a) => a.action === 'invitation.create')!;
      expect(audit.metadata).toEqual({ role: 'MEMBER' });
      expect(JSON.stringify(await audits())).not.toContain(inviteeEmail.split('@')[0]);
      invitee = { email: inviteeEmail, cookie: '', userId: '' };
    });

    it('a signed-out invitee is sent to sign in and lands back on the invitation', async () => {
      const anon = await run(inviteLoader, makeRequest(inviteePath));
      expect(anon.status).toBe(302);
      expect(anon.location).toBe(`/login?next=${encodeURIComponent(inviteePath)}`);
      invitee = await signIn(invitee.email, inviteePath);
      const preview = await run(inviteLoader, makeRequest(inviteePath, { cookie: invitee.cookie }));
      expect(preview.status).toBe(200);
      expect(preview.data).toMatchObject({
        ok: true,
        message: null,
        invitation: { organizationName: 'Hydro Imports Ltd', role: 'MEMBER', forThisUser: true },
      });
    });

    it('someone signed in with another address cannot accept it', async () => {
      const stranger = await signIn(newEmail('stranger'));
      const token = new URL(inviteePath, 'http://x').searchParams.get('token')!;
      const preview = await run(
        inviteLoader,
        makeRequest(inviteePath, { cookie: stranger.cookie }),
      );
      expect(preview.data).toMatchObject({
        invitation: { forThisUser: false },
        message: expect.stringContaining('different email'),
      });
      const res = await post(inviteAction, '/invite/accept', stranger, { token });
      expect(res.status).toBe(403);
      expect(res.data).toMatchObject({ error: expect.stringContaining('different email') });
      const row = await withOrgTransaction(prisma, orgId, (tx) => tx.invitation.findFirstOrThrow());
      expect(row.acceptedAt).toBeNull();
      expect(
        await withOrgTransaction(prisma, orgId, (tx) =>
          tx.membership.count({ where: { userId: stranger.userId } }),
        ),
      ).toBe(0);
    });

    it('the invitee accepts once: membership created, session rotated, both listed; the link is then used', async () => {
      const token = new URL(inviteePath, 'http://x').searchParams.get('token')!;
      const res = await post(inviteAction, '/invite/accept', invitee, { token });
      expect(res.status).toBe(302);
      expect(res.location).toBe('/app');
      const rotated = sessionCookieFrom(res.setCookie)!;
      expect(sessionIdFrom(rotated)).not.toBe(sessionIdFrom(invitee.cookie));
      invitee.cookie = rotated;

      const home = await run(homeLoader, makeRequest('/app', { cookie: invitee.cookie }));
      expect(home.status).toBe(200);
      expect(home.data).toMatchObject({ orgName: 'Hydro Imports Ltd' });

      const list = await run(
        membersLoader,
        makeRequest('/app/settings/members', { cookie: owner.cookie }),
      );
      const data = list.data as {
        members: Array<{ email: string; role: string }>;
        invitations: unknown[];
      };
      expect(data.members.map((m) => [m.email, m.role])).toEqual([
        [owner.email, 'OWNER'],
        [invitee.email, 'MEMBER'],
      ]);
      expect(data.invitations).toEqual([]);
      const rows = await audits();
      expect(rows.map((a) => a.action)).toContain('invitation.accept');
      expect(rows.filter((a) => a.action === 'membership.create')).toHaveLength(2);

      const replay = await post(inviteAction, '/invite/accept', invitee, { token });
      expect(replay.status).toBe(400);
      expect(replay.data).toMatchObject({ error: expect.stringContaining('already been used') });
    });

    it('expired and revoked invitations, and a token for another organisation, are refused', async () => {
      const expiredEmail = newEmail('expired');
      const expired = await withOrgTransaction(
        prisma,
        orgId,
        (tx) =>
          createInvitation(
            tx,
            {
              organizationId: orgId,
              userId: owner.userId,
              role: 'OWNER',
              now: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
            },
            { email: expiredEmail, role: 'VIEWER' },
          ),
        { userId: owner.userId },
      );
      expect(expired.ok).toBe(true);
      const expiredActor = await signIn(expiredEmail);
      const expiredToken = `${orgId}.${(expired as { secret: string }).secret}`;
      expect(
        await run(
          inviteLoader,
          makeRequest(`/invite/accept?token=${expiredToken}`, { cookie: expiredActor.cookie }),
        ),
      ).toMatchObject({
        data: { ok: false, message: expect.stringContaining('expired') },
      });
      expect(
        (await post(inviteAction, '/invite/accept', expiredActor, { token: expiredToken })).data,
      ).toMatchObject({
        error: expect.stringContaining('expired'),
      });

      const revokedEmail = newEmail('revoked');
      await post(membersAction, '/app/settings/members', owner, {
        intent: 'invite',
        email: revokedEmail,
        role: 'VIEWER',
      });
      const revokedPath = lastLinkPath(t.logs)!;
      const pending = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.invitation.findFirstOrThrow({
          where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        }),
      );
      const revoke = await post(membersAction, '/app/settings/members', owner, {
        intent: 'revoke',
        invitationId: pending.id,
      });
      expect(revoke.status).toBe(200);
      expect(
        (
          await post(membersAction, '/app/settings/members', owner, {
            intent: 'revoke',
            invitationId: pending.id,
          })
        ).status,
      ).toBe(400);
      const revokedActor = await signIn(revokedEmail, revokedPath);
      const revokedToken = new URL(revokedPath, 'http://x').searchParams.get('token')!;
      expect(
        (await post(inviteAction, '/invite/accept', revokedActor, { token: revokedToken })).data,
      ).toMatchObject({
        error: expect.stringContaining('withdrawn'),
      });
      expect((await audits()).map((a) => a.action)).toContain('invitation.revoke');

      // Cross-tenant: the same secret under another organisation's id finds nothing.
      const otherOrg = randomUUID();
      const other = await lookupInvitation(
        prisma,
        { organizationId: otherOrg, secret: revokedToken.split('.')[1]! },
        { id: revokedActor.userId, email: revokedEmail },
        new Date(),
      );
      expect(other).toEqual({ ok: false, reason: 'INVALID' });
      expect(
        (
          await run(
            inviteLoader,
            makeRequest('/invite/accept?token=garbage', { cookie: revokedActor.cookie }),
          )
        ).data,
      ).toMatchObject({
        ok: false,
        message: expect.stringContaining('not valid'),
      });
    });

    it('role changes: no self-change, owner-only for OWNER, last owner protected; audited by id', async () => {
      const membership = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.membership.findFirstOrThrow({ where: { userId: invitee.userId } }),
      );
      const own = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.membership.findFirstOrThrow({ where: { userId: owner.userId } }),
      );
      const selfChange = await post(membersAction, '/app/settings/members', owner, {
        intent: 'role',
        membershipId: own.id,
        role: 'ADMIN',
      });
      expect(selfChange.status).toBe(400);
      expect(selfChange.data).toMatchObject({ message: expect.stringContaining('own role') });

      const promote = await post(membersAction, '/app/settings/members', owner, {
        intent: 'role',
        membershipId: membership.id,
        role: 'ADMIN',
      });
      expect(promote.status).toBe(200);
      const changed = (await audits()).find((a) => a.action === 'membership.role_change')!;
      expect(changed.metadata).toEqual({
        memberUserId: invitee.userId,
        from: 'MEMBER',
        to: 'ADMIN',
      });

      // The invitee's session sees the role change on the next request (M1 rotation).
      const rotated = await run(
        membersLoader,
        makeRequest('/app/settings/members', { cookie: invitee.cookie }),
      );
      expect(rotated.status).toBe(302);
      invitee.cookie = sessionCookieFrom(rotated.setCookie)!;
      const asAdmin = await run(
        membersLoader,
        makeRequest('/app/settings/members', { cookie: invitee.cookie }),
      );
      expect(asAdmin.data).toMatchObject({
        role: 'ADMIN',
        canManage: true,
        assignableRoles: ['ADMIN', 'MEMBER', 'VIEWER'],
      });

      // An ADMIN can neither demote the owner nor mint owners.
      const demote = await post(membersAction, '/app/settings/members', invitee, {
        intent: 'role',
        membershipId: own.id,
        role: 'MEMBER',
      });
      expect(demote.data).toMatchObject({ message: expect.stringContaining('Only an owner') });
      const mint = await post(membersAction, '/app/settings/members', invitee, {
        intent: 'invite',
        email: newEmail('mint'),
        role: 'OWNER',
      });
      expect(mint.data).toMatchObject({ message: expect.stringContaining('Only an owner') });
      const removeOwner = await post(membersAction, '/app/settings/members', invitee, {
        intent: 'remove',
        membershipId: own.id,
      });
      expect(removeOwner.data).toMatchObject({ message: expect.stringContaining('Only an owner') });

      // Last owner: exercised at the service level (an owner acting on the only other owner).
      const ghostOwnerId = randomUUID();
      await withOrgTransaction(prisma, orgId, async (tx) => {
        const r = await changeMemberRole(
          tx,
          { organizationId: orgId, userId: ghostOwnerId, role: 'OWNER' },
          { membershipId: own.id, role: 'ADMIN' },
        );
        expect(r).toEqual({ ok: false, message: expect.stringContaining('at least one owner') });
        const d = await removeMember(
          tx,
          { organizationId: orgId, userId: ghostOwnerId, role: 'OWNER' },
          { membershipId: own.id },
        );
        expect(d).toEqual({ ok: false, message: expect.stringContaining('at least one owner') });
      });
      expect(
        (
          await withOrgTransaction(prisma, orgId, (tx) =>
            tx.membership.findUniqueOrThrow({ where: { id: own.id } }),
          )
        ).role,
      ).toBe('OWNER');
    });

    it('removing a member signs them out everywhere and audits by id', async () => {
      const membership = await withOrgTransaction(prisma, orgId, (tx) =>
        tx.membership.findFirstOrThrow({ where: { userId: invitee.userId } }),
      );
      const before = await prisma.user.findUniqueOrThrow({ where: { id: invitee.userId } });
      const noSelf = await post(membersAction, '/app/settings/members', invitee, {
        intent: 'remove',
        membershipId: membership.id,
      });
      expect(noSelf.data).toMatchObject({ message: expect.stringContaining('remove yourself') });

      const res = await post(membersAction, '/app/settings/members', owner, {
        intent: 'remove',
        membershipId: membership.id,
      });
      expect(res.status).toBe(200);
      const after = await prisma.user.findUniqueOrThrow({ where: { id: invitee.userId } });
      expect(after.sessionEpoch).toBe(before.sessionEpoch + 1);

      // Their existing session is gone: any workspace request signs them out.
      const gone = await run(homeLoader, makeRequest('/app', { cookie: invitee.cookie }));
      expect(gone.status).toBe(302);
      expect(gone.location).toBe('/login');
      expect(gone.setCookie[0]).toMatch(/^__Host-harbour_sid=; Path=\/; Max-Age=0/);
      expect(await t.app.auth.sessions!.read(sessionIdFrom(invitee.cookie))).toBeNull();

      const removed = (await audits()).find((a) => a.action === 'membership.delete')!;
      expect(removed.metadata).toEqual({ memberUserId: invitee.userId, role: 'ADMIN' });
      const list = await run(
        membersLoader,
        makeRequest('/app/settings/members', { cookie: owner.cookie }),
      );
      expect((list.data as { members: unknown[] }).members).toHaveLength(1);

      // They can sign in again; they just have no organisation any more.
      const again = await signIn(invitee.email);
      expect((await run(homeLoader, makeRequest('/app', { cookie: again.cookie }))).location).toBe(
        '/onboarding/organization',
      );
    });
  });

  describe('audit log and tenancy', () => {
    it('the audit page lists this organisation only, newest first, with actor labels', async () => {
      const page = await run(
        auditLoader,
        makeRequest('/app/settings/audit?page=1', { cookie: owner.cookie }),
      );
      expect(page.status).toBe(200);
      const data = page.data as {
        rows: Array<{ action: string; actor: { label: string } }>;
        entryCount: number;
        pages: number;
      };
      const actions = data.rows.map((r) => r.action);
      for (const expected of [
        'org.eori.update',
        'org.vat.update',
        'org.customs_profile.update',
        'org.cds_authority.confirm',
        'org.company.confirm',
        'invitation.create',
        'invitation.accept',
        'invitation.revoke',
        'membership.create',
        'membership.role_change',
        'membership.delete',
      ]) {
        expect(actions, expected).toContain(expected);
      }
      expect(actions[0]).toBe('membership.delete');
      expect(data.rows[0]!.actor.label).toBe(owner.email);
      expect(data.entryCount).toBe((await audits()).length);
      const text = JSON.stringify(data);
      expect(text).not.toContain(EORI);
      expect(text).not.toContain(VAT);
      expect(text).not.toContain(DAN);
      const beyond = await run(
        auditLoader,
        makeRequest('/app/settings/audit?page=999', { cookie: owner.cookie }),
      );
      expect((beyond.data as { page: number }).page).toBe(data.pages);
    });

    it('another organisation cannot read this one’s invitations or audit rows', async () => {
      const other = await signIn(newEmail('other-owner'));
      const page = await run(
        onboardingLoader,
        makeRequest('/onboarding/organization', { cookie: other.cookie }),
      );
      const created = await run(
        onboardingAction,
        makeRequest('/onboarding/organization', {
          cookie: other.cookie,
          form: { name: 'Other Co', _csrf: (page.data as { csrfToken: string }).csrfToken },
        }),
      );
      other.cookie = sessionCookieFrom(created.setCookie)!;
      const otherOrgId = (await listUserOrganizations(prisma, other.userId))[0]!.organization.id;
      orgIds.push(otherOrgId);

      const seen = await withOrgTransaction(prisma, otherOrgId, async (tx) => ({
        invitations: await tx.invitation.count(),
        audits: await tx.auditLog.count(),
        hydro: await tx.organization.count({ where: { name: 'Hydro Imports Ltd' } }),
        eoris: await tx.organization.count({ where: { eoriLast4: '9000' } }),
      }));
      expect(seen).toEqual({ invitations: 0, audits: 2, hydro: 0, eoris: 0 });
      expect(
        await withOrgTransaction(prisma, orgId, (tx) => tx.invitation.count()),
      ).toBeGreaterThan(0);

      const audit = await run(
        auditLoader,
        makeRequest('/app/settings/audit', { cookie: other.cookie }),
      );
      expect((audit.data as { rows: Array<{ action: string }> }).rows.map((r) => r.action)).toEqual(
        ['membership.create', 'org.create'],
      );
      const members = await run(
        membersLoader,
        makeRequest('/app/settings/members', { cookie: other.cookie }),
      );
      expect(
        (members.data as { members: Array<{ email: string }> }).members.map((m) => m.email),
      ).toEqual([other.email]);
      const org = await run(
        orgLoader,
        makeRequest('/app/settings/organisation', { cookie: other.cookie }),
      );
      expect((org.data as { identity: { eori: { set: boolean } } }).identity.eori.set).toBe(false);
    });

    it('logs carry no PII: no addresses, EORI, VAT number or DAN (snapshot of the flow’s events)', () => {
      const flow = t.logs.slice(firstLog);
      const text = JSON.stringify(flow);
      for (const secret of [
        EORI,
        VAT,
        DAN,
        '123456789',
        '6782',
        ...emails,
        ...emails.map((e) => e.split('@')[0]!),
      ]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).not.toContain('Hydro Imports');
      const events = [
        ...new Set(
          flow
            .map((l) => l.event)
            .filter((e): e is string => typeof e === 'string' && !e.startsWith('prisma')),
        ),
      ];
      expect(events).toMatchInlineSnapshot(`
        [
          "email.console",
          "auth.link_sent",
          "auth.signed_in",
          "onboarding.org_created",
          "jobs.enqueue_skipped",
          "settings.identity_saved",
          "session.rotated",
          "auth.forbidden",
          "settings.customs_profile_saved",
          "settings.customs_profile_invalid",
          "settings.company_searched",
          "settings.company_confirm_failed",
          "settings.company_confirmed",
          "settings.invite_sent",
          "invite.rejected",
          "invite.accepted",
          "settings.invite_revoked",
          "settings.member_role_changed",
          "settings.member_removed",
          "session.invalidated",
        ]
      `);
    });
  });
});
