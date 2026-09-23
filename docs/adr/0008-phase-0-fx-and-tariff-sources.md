# 0008. Phase 0 FX and tariff sources

- **Status:** Accepted
- **Date:** 2026-09-23
- **Brief:** §5.2, §5.7, §5.8, §7.5

## Context

The engine is pure and takes resolved inputs; the adapters (`packages/adapters`) and the
worker (`apps/worker`) decide where those inputs come from. The brief forbids live FX calls in
the request path and requires tariff lookups to be cached and validated. Phase 0 has no login
and must survive the public calculator being used by people with no verified tariff data.

## Decision

**FX**

- Never fetched in the request path. An `FxRateStore` (Postgres `FxRate` table) is read
  synchronously by the app.
- The worker's HMRC monthly job fetches the published monthly rates on the 25th and the 1st
  and seeds the store with `source = "HMRC_MONTHLY"`, valid for the calendar month.
- If no HMRC rate is available for the currency and month, the ECB daily reference rate
  (fetched by a daily job) is used with `fxSource = "ECB"` and warning `FX_FALLBACK`.
- The public calculator additionally accepts a manually entered rate: `fxSource = "MANUAL"`,
  warning `FX_MANUAL`. Every quote snapshots `fxRate`, `fxSource` and `fxDate`.

**Tariff**

- Lookups go to the UK Trade Tariff API v2 (`/api/v2/commodities/{code}`) through the adapter
  with a 5 s timeout, retries with jitter, a circuit breaker, and a 24 h cache in
  `TariffCache`. Responses are validated with zod before the measures reach the engine.
- The public calculator also allows the user to type duty and VAT rates directly
  (`tariff.kind = "MANUAL"`). Such quotes always carry `TARIFF_MANUAL` **and** `HS_UNVERIFIED`,
  so they are `INDICATIVE` by construction and can never be accepted.
- HS codes are verified only by a successful live/cached lookup; `hsCodeVerifiedAt` is set
  then and only then.

## Consequences

- The request path depends on Postgres only; an HMRC, ECB or tariff API outage degrades to a
  labelled fallback or an `INDICATIVE` quote, never a 500.
- The FX store must be seeded before the first deploy of a month (`docs/runbooks/tariff-or-fx-job-failed.md`).
- Contract tests for the tariff adapter run against recorded fixtures in
  `packages/adapters/fixtures/`. The initial fixtures are hand-authored in the documented
  JSON:API shape because the build sandbox had no access to the API; they must be re-recorded
  against the live API before those tests are trusted (`docs/decisions-needed.md`, item (e)).
