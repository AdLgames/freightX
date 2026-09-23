import { CompaniesHouseClient, type FetchLike } from '@harbour/adapters';
import { createKeyProvider, type KeyProvider } from '@harbour/db';
import type { Env } from '../env.server';
import type { Logger } from '../logger.server';
import type { WorkspaceUnavailable } from '../workspace.server';
import { createJobEnqueuer, type JobEnqueuer } from './jobs.server';

/**
 * M2 — what the settings pages need beyond M1's auth services, decided once at startup:
 *
 *   FIELD_ENCRYPTION_KEY   → `keyProvider` (EnvKeyProvider). Production without it → the workspace
 *                            is closed (`unavailable: 'NO_FIELD_ENCRYPTION_KEY'`, 503 on every
 *                            workspace route; the calculator is unaffected). Development/test
 *                            without it → an EPHEMERAL key and a loud warning: encrypted values do
 *                            not survive a restart.
 *   COMPANIES_HOUSE_API_KEY → `companiesHouse` client, or null (the lookup step says it is off and
 *                            offers "I'm a sole trader or partnership" only).
 *   REDIS_URL              → BullMQ job enqueuer, else the in-memory one (logs, never runs).
 *   FORWARDER_EORI / _NAME → shown in the CDS authorisation step; unset → "to be confirmed".
 */
export interface ForwarderDetails {
  eori: string | null;
  name: string | null;
}

export interface SettingsServices {
  /** null only when `unavailable` is set (production, no/bad key). */
  keyProvider: KeyProvider | null;
  /** For the startup log: presence only. */
  fieldEncryption: 'configured' | 'ephemeral' | 'missing';
  companiesHouse: CompaniesHouseClient | null;
  jobs: JobEnqueuer;
  forwarder: ForwarderDetails;
  unavailable: Extract<WorkspaceUnavailable, 'NO_FIELD_ENCRYPTION_KEY'> | null;
}

export interface SettingsServicesDeps {
  env: Env;
  logger: Logger;
  /** Test seams. */
  jobs?: JobEnqueuer;
  companiesHouseFetch?: FetchLike;
  companiesHouseBaseUrl?: string;
}

export const createSettingsServices = (deps: SettingsServicesDeps): SettingsServices => {
  const { env, logger } = deps;
  const production = env.NODE_ENV === 'production';

  const key = createKeyProvider({ masterKey: env.FIELD_ENCRYPTION_KEY, nodeEnv: env.NODE_ENV });
  let unavailable: SettingsServices['unavailable'] = null;
  if (key.provider === null) {
    // Malformed key anywhere, or unset in production: fail closed. Logged once, at startup.
    logger.error('settings.field_encryption_unavailable', {
      message: `${key.problem} Workspace routes return 503 until it is fixed.`,
    });
    unavailable = 'NO_FIELD_ENCRYPTION_KEY';
  } else if (key.ephemeral) {
    logger.warn('settings.field_encryption_ephemeral', {
      message:
        'FIELD_ENCRYPTION_KEY is unset: using an EPHEMERAL key. Encrypted EORI/VAT numbers become unreadable when this process restarts. Set the key (see apps/web/README.md).',
    });
  }
  if (production && key.provider === null) unavailable = 'NO_FIELD_ENCRYPTION_KEY';

  const companiesHouse = env.COMPANIES_HOUSE_API_KEY
    ? new CompaniesHouseClient({
        apiKey: env.COMPANIES_HOUSE_API_KEY,
        ...(deps.companiesHouseFetch ? { fetch: deps.companiesHouseFetch } : {}),
        ...(deps.companiesHouseBaseUrl ? { baseUrl: deps.companiesHouseBaseUrl } : {}),
      })
    : null;
  if (!companiesHouse) {
    logger.info('settings.companies_house_off', {
      message: 'COMPANIES_HOUSE_API_KEY is unset: company lookup is not available.',
    });
  }

  const jobs = deps.jobs ?? createJobEnqueuer(env.REDIS_URL, logger);
  const forwarder: ForwarderDetails = {
    eori: env.FORWARDER_EORI ?? null,
    name: env.FORWARDER_NAME ?? null,
  };

  return {
    keyProvider: key.provider,
    fieldEncryption: key.provider === null ? 'missing' : key.ephemeral ? 'ephemeral' : 'configured',
    companiesHouse,
    jobs,
    forwarder,
    unavailable,
  };
};
