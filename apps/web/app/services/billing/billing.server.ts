import type { PrismaClient } from '@harbour/db';
import { PAID_PLANS, type PaidPlan, type StripeEventEnvelope } from '../../validators/billing';
import type { EmailTransport } from '../email.server';
import type { Env } from '../env.server';
import type { Logger } from '../logger.server';
import { handleStripeEvent, type HandleResult, type PlanPriceMap } from './events.server';
import {
  InlineStripeEventEnqueuer,
  startStripeEventQueue,
  type StripeEventEnqueuer,
} from './queue.server';
import { PrismaBillingRepository, type BillingRepository } from './repository.server';
import {
  FakeBillingGateway,
  StripeGateway,
  priceDisplayFrom,
  type BillingGateway,
  type PriceDisplay,
} from './stripe.server';

/**
 * Billing composition (M6), built once by app.server.ts. Everything is optional:
 *
 *   no STRIPE_SECRET_KEY / price ids  → `configured = false`: the billing page says "Billing is not
 *                                       configured"; nothing else in the app changes.
 *   no STRIPE_WEBHOOK_SECRET          → POST /webhooks/stripe answers 503 (Stripe retries; ops sees
 *                                       `billing.configured`).
 *   no DATABASE_URL                   → no repository, no enqueuer: the webhook cannot record
 *                                       events and answers 503.
 *   no REDIS_URL                      → events are processed inline (dev/test).
 *
 * Secrets are never logged; `billing.configured` reports presence only.
 */
export interface BillingServices {
  /** Checkout and portal are possible: gateway + both price ids. */
  configured: boolean;
  gateway: BillingGateway | null;
  prices: PlanPriceMap;
  webhookSecret: string | null;
  enqueuer: StripeEventEnqueuer | null;
  repository: BillingRepository | null;
  /** Processes one verified event now (inline path and the BullMQ consumer both use it). */
  handle: (event: StripeEventEnvelope) => Promise<HandleResult>;
  /** Prices for the billing page, from Stripe, cached briefly. Empty when unavailable. */
  priceDisplays: () => Promise<PriceDisplay[]>;
  /** Stops the BullMQ consumer (tests / shutdown). */
  close: () => Promise<void>;
}

export interface BillingServicesDeps {
  env: Env;
  logger: Logger;
  prisma: PrismaClient | null;
  email: EmailTransport | null;
  appUrl: string | null;
  now?: () => Date;
  /** Test seams. */
  gateway?: BillingGateway | null;
  repository?: BillingRepository;
  /** Default: from env.REDIS_URL. Pass null to force inline processing. */
  redisUrl?: string | null;
}

export const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;

export const createBillingServices = async (
  deps: BillingServicesDeps,
): Promise<BillingServices> => {
  const { env, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const prices: PlanPriceMap = {
    STARTER: env.STRIPE_PRICE_STARTER ?? null,
    PRO: env.STRIPE_PRICE_PRO ?? null,
  };

  const gateway: BillingGateway | null =
    deps.gateway !== undefined
      ? deps.gateway
      : env.STRIPE_SECRET_KEY
        ? new StripeGateway(env.STRIPE_SECRET_KEY)
        : null;
  const configured = gateway !== null && prices.STARTER !== null && prices.PRO !== null;

  const repository: BillingRepository | null =
    deps.repository ?? (deps.prisma ? new PrismaBillingRepository(deps.prisma) : null);

  const handle = async (event: StripeEventEnvelope): Promise<HandleResult> => {
    if (!repository) throw new Error('billing repository unavailable (no DATABASE_URL)');
    return handleStripeEvent(event, {
      repo: repository,
      prices,
      email: deps.email,
      appUrl: deps.appUrl,
      logger,
      now,
    });
  };

  let enqueuer: StripeEventEnqueuer | null = null;
  let close = async (): Promise<void> => {};
  const redisUrl = deps.redisUrl === undefined ? (env.REDIS_URL ?? null) : deps.redisUrl;
  if (repository) {
    if (redisUrl) {
      const started = await startStripeEventQueue(redisUrl, handle, logger);
      enqueuer = started.enqueuer;
      close = () => started.worker.close();
    } else {
      enqueuer = new InlineStripeEventEnqueuer(handle, logger);
    }
  }

  // Price display cache: one Stripe round-trip per 5 minutes per process, never per page view.
  let cache: { at: number; value: PriceDisplay[] } | null = null;
  const priceDisplays = async (): Promise<PriceDisplay[]> => {
    if (!gateway || !configured) return [];
    if (cache && now().getTime() - cache.at < PRICE_CACHE_TTL_MS) return cache.value;
    const ids = PAID_PLANS.map((plan) => ({ plan, id: prices[plan] })).filter(
      (p): p is { plan: PaidPlan; id: string } => p.id !== null,
    );
    try {
      const found = await gateway.retrievePrices(ids.map((p) => p.id));
      const value = ids.flatMap((p) => {
        const price = found.find((f) => f.id === p.id);
        return price ? [priceDisplayFrom(price, p.plan)] : [];
      });
      cache = { at: now().getTime(), value };
      return value;
    } catch (err) {
      logger.warn('billing.prices_unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  };

  const problems: string[] = [];
  if (gateway && !configured)
    problems.push('STRIPE_PRICE_STARTER and STRIPE_PRICE_PRO are required');
  if (!env.STRIPE_WEBHOOK_SECRET && gateway) problems.push('STRIPE_WEBHOOK_SECRET is unset');
  logger.info('billing.configured', {
    configured,
    gateway: gateway?.name ?? null,
    webhookSecret: Boolean(env.STRIPE_WEBHOOK_SECRET),
    queue: enqueuer?.backend ?? null,
    ...(problems.length > 0 ? { problems } : {}),
  });

  return {
    configured,
    gateway,
    prices,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    enqueuer,
    repository,
    handle,
    priceDisplays,
    close,
  };
};

/** Test helper: a fully configured billing service on a fake gateway. */
export const fakeBillingDeps = (): { gateway: FakeBillingGateway; env: Partial<Env> } => ({
  gateway: new FakeBillingGateway(),
  env: {
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    STRIPE_PRICE_STARTER: 'price_FakeStarter001',
    STRIPE_PRICE_PRO: 'price_FakePro001',
  },
});
