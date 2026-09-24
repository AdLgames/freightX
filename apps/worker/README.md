# @harbour/worker

Background jobs for Harbour (engineering brief §3, §5.7, §5.8, §7.8, §11 item 4): BullMQ on Redis,
one queue per job. The request path never calls a tariff or FX provider; these jobs are the only
writers of `FxRate` and the nightly re-warmers of `TariffCache`.

## Jobs

| Queue             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Schedule (UTC)                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `fx-refresh`      | Fetches this month's HMRC monthly CSV and, from the 25th, next month's (HMRC publishes ~1 week before the month starts; a 404 for next month before that is expected, not an alert). Parses and upserts on `(source, currency, validFrom)`. On the 2nd or later, if the current month's HMRC rates are still absent it raises **critical `FX_HMRC_MISSING`**. Then fetches ECB daily reference rates as fallback data (valid 7 days). 5s timeout, 2 retries with jitter per request.                                                                                                                     | `0 6 * * *` daily, plus `0 7 1,25 * *` (§5.7) |
| `tariff-refresh`  | Re-warms the tariff cache for every active commodity code through `UkTradeTariffClient` (≤ 5 concurrent, 100 ms between starts). Entries older than an hour are refetched (`refreshingCacheView`). Summarises ok / notFound / unavailable; raises **warning `TARIFF_REFRESH_DEGRADED`** if more than 20 % of codes were unavailable.                                                                                                                                                                                                                                                                     | `0 2 * * *` nightly                           |
| `document-scan`   | M5, on demand (no schedule): one job per completed upload, `{ documentId, organizationId }`, enqueued by the web app. Streams the object, computes sha256, checks magic bytes against the declared type, then runs the malware scanner (`CLAMD_HOST`, else none). Outcome: `REJECTED` (object deleted, reason kept), `CLEAN` (scanner ran) or `UPLOADED` + `not_scanned` (no scanner: never Clean). A `FOUND` raises **warning `DOCUMENT_MALWARE_FOUND`**. See "Environment".                                                                                                                            | none (on demand)                              |
| `quote-expiry`    | Calls `QuoteExpiryPort.expireQuotesPastValidUntil(now)`: moves `READY`, `INDICATIVE` and `DRAFT` quotes past `validUntil` to `EXPIRED`. **Never touches `ACCEPTED`** (immutable, §5.9) nor `CANCELLED`/`EXPIRED` rows. Returns the count.                                                                                                                                                                                                                                                                                                                                                                | `0 * * * *` hourly (§5.8)                     |
| Queue             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Schedule (UTC)                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `fx-refresh`      | Fetches this month's HMRC monthly CSV and, from the 25th, next month's (HMRC publishes ~1 week before the month starts; a 404 for next month before that is expected, not an alert). Parses and upserts on `(source, currency, validFrom)`. On the 2nd or later, if the current month's HMRC rates are still absent it raises **critical `FX_HMRC_MISSING`**. Then fetches ECB daily reference rates as fallback data (valid 7 days). 5s timeout, 2 retries with jitter per request.                                                                                                                     | `0 6 * * *` daily, plus `0 7 1,25 * *` (§5.7) |
| `tariff-refresh`  | Re-warms the tariff cache for every active commodity code through `UkTradeTariffClient` (≤ 5 concurrent, 100 ms between starts). Entries older than an hour are refetched (`refreshingCacheView`). Summarises ok / notFound / unavailable; raises **warning `TARIFF_REFRESH_DEGRADED`** if more than 20 % of codes were unavailable.                                                                                                                                                                                                                                                                     | `0 2 * * *` nightly                           |
| `quote-expiry`    | Calls `QuoteExpiryPort.expireQuotesPastValidUntil(now)`: moves `READY`, `INDICATIVE` and `DRAFT` quotes past `validUntil` to `EXPIRED`. **Never touches `ACCEPTED`** (immutable, §5.9) nor `CANCELLED`/`EXPIRED` rows. Returns the count.                                                                                                                                                                                                                                                                                                                                                                | `0 * * * *` hourly (§5.8)                     |
| `vessel-poll`     | M9 (ADR-0017). Selects `active_vessels` with `nextPollAt <= now` and `pollState <> DOCKED`, calls the AIS provider once per batch (chunked to its limit; per ship, never per container), stores the real fix (`positionSource` = provider), and sets `pollState`/`nextPollAt` from the distance to the destination `Port`: at sea 18 h, within 200 km of a choke point or listed port 5 h, within 50 nmi 1 h. Consecutive failures are counted in `lastError`; the 3rd marks the vessel `STALE` (retried daily) and raises **warning `TRACKING_POSITION_STALE`**. Provider `none` → logs once and exits. | `30 * * * *` hourly                           |
| `tracking-poll`   | M9 (brief §6.4 fallback). Shipments with a provider subscription, not DELIVERED/CANCELLED, no event in 24 h and not polled in 6 h (`withTrackingSweep`) are polled through `MilestoneProvider.pollShipment`; events go through the same processor as webhooks. Provider `none` → skipped.                                                                                                                                                                                                                                                                                                                | `15 */6 * * *`                                |
| `tracking-events` | M9. Consumes `{ source, events }` jobs the web app's webhook route enqueued; per organisation tracking the container number: upsert `ShipmentEvent` on `(organization, source, providerEventId)`, apply the `ShipmentStatus` table (illegal transitions stored, status unchanged, warning logged), update the container and the shared `active_vessels` count (kill switch at zero). No schedule (event-driven); retries are idempotent.                                                                                                                                                                 | none                                          |

### Event-driven: `stripe-events` (M6)

Not in the table above because it has no schedule: `POST /webhooks/stripe` in the web app verifies
the Stripe signature, records the event id in `stripe_events` (duplicates are dropped there) and
enqueues `{ eventId, type, payload }` with `jobId = eventId`, `attempts: 5`, exponential backoff
from 30 s and **failed jobs kept** (the dead-letter set of brief §6.4). The job contract lives in
`src/jobs/stripe-events.ts` and must stay identical to
`apps/web/app/services/billing/queue.server.ts`.

Who consumes it: **the web app itself** by default (it has Prisma and the email transport). Set
`STRIPE_EVENTS_CONSUMER=worker` to make this process consume instead — today that fails every job
loudly (`UnconfiguredStripeEventHandler`) and raises **critical `STRIPE_EVENT_DEAD_LETTERED`** after
the 5th attempt, because the worker has no database yet (same `TODO(db)` as the other ports). Wire
a Prisma-backed `StripeEventHandlerPort` (the logic is `apps/web/app/services/billing/events.server.ts`)
before flipping it. Without `REDIS_URL` the web app processes events inline and says so in its log.

Job options on every scheduler: `attempts: 5`, exponential backoff from 30 s, `removeOnComplete: 100`,
`removeOnFail: 500`. Schedulers are registered with `Queue.upsertJobScheduler` on every boot under
stable ids (`fx-refresh:daily`, `fx-refresh:hmrc-publication`, `tariff-refresh:nightly`,
`quote-expiry:hourly`), so restarts are idempotent and changing a cron string updates it in place.

The FX schedule is deliberately simple: the job logic decides what is due (which months, whether
"missing by the 2nd" applies), so running it more often is harmless.

### Failure semantics

- Provider errors (HTTP 5xx, timeouts, network, format changes) **never throw**. They are reported
  through the `AlertSink` and in the job summary; the next scheduled run tries again.
- Store (database) errors **do throw**, so BullMQ retries with backoff and, after the 5th failure,
  the worker raises **critical `JOB_FAILED`**.
- Alert codes: `FX_HMRC_MISSING` (critical), `FX_HMRC_FETCH_FAILED`, `FX_HMRC_PARSE_FAILED`,
  `FX_ECB_FETCH_FAILED`, `FX_ECB_PARSE_FAILED`, `TARIFF_REFRESH_DEGRADED` (warning),
  `JOB_FAILED` (critical). A parse failure means the upstream format changed: a code change, not an
  ops action.

## Environment

| Variable                      | Required              | Meaning                                                                                                                                                                                                   |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                   | yes (except `--once`) | Redis connection string for BullMQ, e.g. `redis://localhost:6379`. The connection is created with `maxRetriesPerRequest: null`.                                                                           |
| `ALERT_WEBHOOK_URL`           | no                    | If set, alerts are also POSTed as JSON (`{source, level, code, message, meta, at}`) with a 5 s timeout. Delivery failures are logged, never thrown. Wire PagerDuty / OpsGenie / Slack behind it (§7.8).   |
| `WORKER_PORT`                 | no (default `9090`)   | Port for `GET /healthz`, which returns `{ ok, startedAt, queues: [{ name, lastRun }] }` with the last completed/failed run per queue.                                                                     |
| `TARIFF_REFRESH_CODES`        | no                    | Phase 0: comma-separated 10-digit commodity codes to re-warm nightly. Phase 1 replaces this with every `Product.hsCode` in the DB (see `wiring.server.ts`).                                               |
| `UK_TRADE_TARIFF_BASE_URL`    | no                    | Override the UK Trade Tariff API base URL (tests, recorded fixtures).                                                                                                                                     |
| `STRIPE_EVENTS_CONSUMER`      | no (default `web`)    | M6: `worker` starts a consumer for the `stripe-events` queue in this process (needs a database-backed handler, not wired yet); `web` leaves it to the web app.                                            |
| `STORAGE_*`, `CLAMD_*`        | for `document-scan`   | M5: same variables as the web app (root `.env.example`) plus `DATABASE_URL` as a `harbour_app` member. Unset → each `document-scan` job fails with "not configured"; other queues are unaffected.         |
| Variable                      | Required              | Meaning                                                                                                                                                                                                   |
| ----------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                   | yes (except `--once`) | Redis connection string for BullMQ, e.g. `redis://localhost:6379`. The connection is created with `maxRetriesPerRequest: null`.                                                                           |
| `ALERT_WEBHOOK_URL`           | no                    | If set, alerts are also POSTed as JSON (`{source, level, code, message, meta, at}`) with a 5 s timeout. Delivery failures are logged, never thrown. Wire PagerDuty / OpsGenie / Slack behind it (§7.8).   |
| `WORKER_PORT`                 | no (default `9090`)   | Port for `GET /healthz`, which returns `{ ok, startedAt, queues: [{ name, lastRun }] }` with the last completed/failed run per queue.                                                                     |
| `TARIFF_REFRESH_CODES`        | no                    | Phase 0: comma-separated 10-digit commodity codes to re-warm nightly. Phase 1 replaces this with every `Product.hsCode` in the DB (see `wiring.server.ts`).                                               |
| `UK_TRADE_TARIFF_BASE_URL`    | no                    | Override the UK Trade Tariff API base URL (tests, recorded fixtures).                                                                                                                                     |
| `DATABASE_URL`                | no (M9 jobs)          | Postgres for the tracking jobs (`@harbour/db`). Unset → `vessel-poll`, `tracking-poll` and `tracking-events` log and exit. Same `harbour_app` member as the web app for now (packages/db README, "0010"). |
| `TRACKING_POSITION_PROVIDER`  | no (default `none`)   | `spire` (`SPIRE_API_TOKEN`) or `marinetraffic` (`MARINETRAFFIC_API_KEY`) for `vessel-poll`. Adapters are "TO CONFIRM" against the live APIs (decisions-needed (ae)).                                      |
| `TRACKING_MILESTONE_PROVIDER` | no (default `none`)   | `terminal49` (`TERMINAL49_API_KEY`) for the `tracking-poll` fallback.                                                                                                                                     |

Alerts always go to stdout as structured JSON (`{"event":"alert",...}`) in addition to the webhook.

## Running

```sh
pnpm --filter @harbour/worker run build
REDIS_URL=redis://localhost:6379 node apps/worker/dist/main.js      # long-running worker
curl localhost:9090/healthz
```

Run one job inline, without Redis (local dev, and the runbook's "re-run the job" step):

```sh
node apps/worker/dist/main.js --once fx-refresh
node apps/worker/dist/main.js --once tariff-refresh     # uses TARIFF_REFRESH_CODES
node apps/worker/dist/main.js --once quote-expiry
# or: pnpm --filter @harbour/worker run once -- fx-refresh
```

`--once` prints `job.started` / `job.completed` (with the summary) as JSON and exits 0, or
`job.failed` and exits 1. SIGTERM/SIGINT close the workers, the health server and the Redis
connection (30 s hard limit).

Logs are one JSON object per line: `job.started`, `job.completed` (`summary` = counts, months,
timestamps), `job.failed` (`errorName`, `errorMessage`, attempt), `alert`, `scheduler.registered`,
`worker.started` / `worker.stopping` / `worker.stopped`. No PII is logged; provider payloads contain
none.

## Persistence ports

The jobs depend only on the small interfaces in `src/ports.ts` (`FxRateStore` from
`@harbour/adapters`, `QuoteExpiryPort`, `HsCodeSource`, `AlertSink`). `src/wiring.server.ts` is the
composition root and currently wires the in-memory implementations; the `TODO(db)` block there says
what each Prisma-backed implementation must do once `@harbour/db` ships.

## Tests

```sh
pnpm --filter @harbour/worker run test
REDIS_URL=redis://localhost:6379 pnpm --filter @harbour/worker run test   # also runs the BullMQ integration test
```

Unit tests use an injected fake `fetch`, a fixed clock and the fixtures in
`packages/adapters/fixtures/fx`; nothing touches the network or Redis. The integration test
(`test/redis.integration.test.ts`) is skipped unless `REDIS_URL` is set (CI sets it).

## Runbook

Alerts from this worker are handled by
[`docs/runbooks/tariff-or-fx-job-failed.md`](../../docs/runbooks/tariff-or-fx-job-failed.md).
The runbook refers to the jobs as `fx.hmrc-monthly`, `fx.ecb-daily` and `tariff.refresh`; they
map to the `fx-refresh` (both FX sources, one run) and `tariff-refresh` queues here. Circuit
breaker incidents: [`docs/runbooks/circuit-breaker-open.md`](../../docs/runbooks/circuit-breaker-open.md).

## Identity verification jobs (M2)

`eori-verify` and `vat-verify` are **on-demand** queues (no cron): apps/web adds a job
`{ organizationId }` when an EORI or VAT number is saved in Settings. The job reads the
**encrypted** number and the organisation's wrapped data key, decrypts in memory, calls the HMRC
checker (`HmrcEoriChecker` / `HmrcVatChecker` in `@harbour/adapters`) and writes
`eori_/vat_verification_status` (`VALID` / `INVALID` / `ERROR`) plus `_verified_at`, only if the
stored ciphertext is unchanged since the job was queued. A definite HMRC answer completes the
job; `UNAVAILABLE` / `MALFORMED` / `BAD_REQUEST` records `ERROR` and throws so BullMQ retries;
three consecutive errors for one organisation raise **warning `IDENTITY_VERIFY_REPEATED_ERROR`**.
The number never appears in a log, summary or alert.

| Variable               | Meaning                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`         | Same database as apps/web. The store (`identity-store.server.ts`) runs every statement inside `withOrgTransaction(organizationId)`, so the login role must be a non-superuser member of `harbour_app` (RLS). |
| `FIELD_ENCRYPTION_KEY` | The **same** master key as apps/web. Unset → the identity jobs fail with a clear error; the FX/tariff/expiry jobs are unaffected.                                                                            |
| `HMRC_API_BASE_URL`    | Optional override of `https://api.service.hmrc.gov.uk` (tests, sandbox).                                                                                                                                     |

Run one inline: `node dist/main.js --once eori-verify --data '{"organizationId":"<uuid>"}'`.
