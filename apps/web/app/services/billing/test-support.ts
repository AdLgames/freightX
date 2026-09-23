/**
 * Billing test harness (imported only by *.test.ts). Builds the real app through
 * `createTestApp` and swaps `app.billing` for one on a `FakeBillingGateway`, processing webhook
 * events inline. Also the quickest way to a signed-in OWNER: a user row, an organisation via
 * `createOrganization`, and a session straight from the SessionManager (the magic-link flow is
 * covered by auth-flow.db.test.ts).
 */
import { randomUUID } from 'node:crypto';
import { withOrgTransaction, type PrismaClient, type Role } from '@harbour/db';
import { setAppForTests } from '../app.server';
import type { EmailTransport } from '../email.server';
import { loadEnv } from '../env.server';
import { createOrganization } from '../organizations.server';
import {
  ORIGIN,
  cookieFor,
  createTestApp,
  uniqueEmail,
  type TestApp,
} from '../../test-support/harness';
import { createBillingServices, fakeBillingDeps } from './billing.server';
import { FakeBillingGateway } from './stripe.server';

export interface BillingTestApp extends TestApp {
  gateway: FakeBillingGateway;
}

export interface BillingTestAppOptions {
  databaseUrl?: string | undefined;
  /** false → no Stripe keys at all ("Billing is not configured"). Default true. */
  configured?: boolean;
  email?: EmailTransport;
  env?: Record<string, string>;
}

const stripeEnvFor = (configured: boolean): Record<string, string> => {
  const { env } = fakeBillingDeps();
  return configured
    ? {
        STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET!,
        STRIPE_PRICE_STARTER: env.STRIPE_PRICE_STARTER!,
        STRIPE_PRICE_PRO: env.STRIPE_PRICE_PRO!,
      }
    : {};
};

/**
 * Replaces `app.billing` on an existing test app (sessions, database and logs are kept), so a test
 * can flip between configured and unconfigured without signing in again.
 */
export const reconfigureBilling = async (
  t: TestApp,
  configured: boolean,
  extraEnv: Record<string, string> = {},
): Promise<BillingTestApp> => {
  const gateway = new FakeBillingGateway();
  const env = loadEnv({
    NODE_ENV: 'test',
    APP_URL: t.app.auth.appUrl ?? '',
    ...(t.app.env.DATABASE_URL ? { DATABASE_URL: t.app.env.DATABASE_URL } : {}),
    ...stripeEnvFor(configured),
    ...extraEnv,
  });
  const billing = await createBillingServices({
    env,
    logger: t.app.logger,
    prisma: t.prisma,
    email: t.app.auth.email,
    appUrl: t.app.auth.appUrl,
    gateway: configured ? gateway : null,
    redisUrl: null,
  });
  const app = { ...t.app, billing };
  setAppForTests(app);
  return { ...t, app, gateway };
};

export const createBillingTestApp = async (
  opts: BillingTestAppOptions = {},
): Promise<BillingTestApp> => {
  const configured = opts.configured ?? true;
  // APP_URL as in production: the payment-failed email needs an absolute link, and the CSRF
  // Origin check then compares against it (the harness requests come from ORIGIN).
  const extraEnv: Record<string, string> = {
    APP_URL: ORIGIN,
    ...stripeEnvFor(configured),
    ...opts.env,
  };
  const t = await createTestApp({
    databaseUrl: opts.databaseUrl,
    env: extraEnv,
    ...(opts.email ? { email: opts.email } : {}),
  });
  return reconfigureBilling(t, configured, opts.env);
};

export interface SeededOwner {
  userId: string;
  email: string;
  orgId: string;
  cookie: string;
  csrfToken: string;
}

/** A user + organisation (OWNER) + live session. Returns what a request needs. */
export const seedOwner = async (
  t: TestApp,
  prisma: PrismaClient,
  label = 'owner',
): Promise<SeededOwner> => {
  const email = uniqueEmail(label);
  const user = await prisma.user.create({ data: { email }, select: { id: true } });
  const { organizationId } = await createOrganization(prisma, {
    userId: user.id,
    name: `${label} Ltd`,
  });
  const session = await t.app.auth.sessions!.create({
    userId: user.id,
    currentOrgId: organizationId,
    role: 'OWNER',
  });
  return {
    userId: user.id,
    email,
    orgId: organizationId,
    cookie: cookieFor(session.id),
    csrfToken: session.data.csrfToken,
  };
};

/** Another member of `orgId` with `role`, signed in. */
export const seedMember = async (
  t: TestApp,
  prisma: PrismaClient,
  orgId: string,
  role: Role,
): Promise<Omit<SeededOwner, 'orgId'> & { orgId: string }> => {
  const email = uniqueEmail(role.toLowerCase());
  const user = await prisma.user.create({ data: { email }, select: { id: true } });
  await withOrgTransaction(prisma, orgId, (tx) =>
    tx.membership.create({ data: { organizationId: orgId, userId: user.id, role } }),
  );
  const session = await t.app.auth.sessions!.create({ userId: user.id, currentOrgId: orgId, role });
  return {
    userId: user.id,
    email,
    orgId,
    cookie: cookieFor(session.id),
    csrfToken: session.data.csrfToken,
  };
};

/** Deletes everything the seeds created, in the right order. */
export const cleanupOrgs = async (prisma: PrismaClient, orgIds: string[], emails: string[]) => {
  for (const orgId of orgIds) {
    await withOrgTransaction(prisma, orgId, async (tx) => {
      await tx.customsProfile.deleteMany();
      await tx.membership.deleteMany();
      await tx.organization.deleteMany();
    });
  }
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
};

export const newOrgId = (): string => randomUUID();
