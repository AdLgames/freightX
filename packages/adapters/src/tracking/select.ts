import { MarineTrafficPositionProvider } from './marinetraffic.js';
import { NotConfiguredMilestoneProvider, NotConfiguredPositionProvider } from './not-configured.js';
import { SpirePositionProvider } from './spire.js';
import { Terminal49MilestoneProvider } from './terminal49.js';
import type { HttpFetch, MilestoneProvider, PositionProvider } from './types.js';

/**
 * Provider selection from environment (`TRACKING_MILESTONE_PROVIDER`, `TRACKING_POSITION_PROVIDER`).
 * Unknown or missing values fail closed to the not-configured providers; the caller logs the
 * choice once at startup (name only — never a key).
 */
export const MILESTONE_PROVIDER_IDS = ['terminal49', 'none'] as const;
export type MilestoneProviderId = (typeof MILESTONE_PROVIDER_IDS)[number];
export const POSITION_PROVIDER_IDS = ['spire', 'marinetraffic', 'none'] as const;
export type PositionProviderId = (typeof POSITION_PROVIDER_IDS)[number];

export interface TrackingEnv {
  TRACKING_MILESTONE_PROVIDER?: string | undefined;
  TRACKING_POSITION_PROVIDER?: string | undefined;
  TERMINAL49_API_KEY?: string | undefined;
  TERMINAL49_BASE_URL?: string | undefined;
  SPIRE_API_TOKEN?: string | undefined;
  SPIRE_ENDPOINT?: string | undefined;
  MARINETRAFFIC_API_KEY?: string | undefined;
  MARINETRAFFIC_BASE_URL?: string | undefined;
}

export const createMilestoneProvider = (
  env: TrackingEnv,
  opts: { fetch?: HttpFetch; now?: () => Date } = {},
): MilestoneProvider => {
  if (env.TRACKING_MILESTONE_PROVIDER === 'terminal49') {
    return new Terminal49MilestoneProvider({
      apiKey: env.TERMINAL49_API_KEY,
      ...(env.TERMINAL49_BASE_URL ? { baseUrl: env.TERMINAL49_BASE_URL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
  }
  return new NotConfiguredMilestoneProvider();
};

export const createPositionProvider = (
  env: TrackingEnv,
  opts: { fetch?: HttpFetch } = {},
): PositionProvider => {
  if (env.TRACKING_POSITION_PROVIDER === 'spire') {
    return new SpirePositionProvider({
      token: env.SPIRE_API_TOKEN,
      ...(env.SPIRE_ENDPOINT ? { endpoint: env.SPIRE_ENDPOINT } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }
  if (env.TRACKING_POSITION_PROVIDER === 'marinetraffic') {
    return new MarineTrafficPositionProvider({
      apiKey: env.MARINETRAFFIC_API_KEY,
      ...(env.MARINETRAFFIC_BASE_URL ? { baseUrl: env.MARINETRAFFIC_BASE_URL } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }
  return new NotConfiguredPositionProvider();
};

/** Webhook providers by URL id; the secret for each comes from env in the route. */
export const milestoneProviderForWebhook = (
  providerId: string,
  env: TrackingEnv,
  opts: { now?: () => Date } = {},
): MilestoneProvider | null => {
  if (providerId === 'terminal49') {
    return new Terminal49MilestoneProvider({
      apiKey: env.TERMINAL49_API_KEY,
      ...(opts.now ? { now: opts.now } : {}),
    });
  }
  return null;
};
