# Harbour — landed-cost & import workspace (freightX)

Quotes the fully landed cost per unit of a UK import (freight + duty + VAT + fees) before the
customer commits to a supplier, then (Phase 1) keeps their products, HS codes, suppliers and
documents so every future quote takes seconds. Spec: [`docs/engineering-brief.md`](docs/engineering-brief.md).

> We are a calculator and a system of record, not a carrier. Nothing here is a contractual rate.
> We are never the freight forwarder, never the customs principal, and never hold client money.

## Status

Sprint 1 scaffold (brief §11). Phase 0 public calculator is wired end to end; Phase 1 workspace
(auth, orgs, saved quotes, documents, Stripe) is schema-only; Phase 2 (booking/tracking) is
designed in the schema and ADRs but has no code, by design.

| Area                | State                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/engine`   | Pure landed-cost engine: HS normalisation, tariff-measure parser, customs value, apportionment, incoterm branching. 28 golden fixtures + property tests.                            |
| `packages/adapters` | UK Trade Tariff client (zod-validated, 24h cache, retry), HMRC monthly / ECB FX parsers + store, rate sheet v1, circuit-breaker composition, SeaRates stub.                         |
| `packages/db`       | Prisma 6 schema per brief §4 (+ additions marked in comments), migrations incl. RLS policies and accepted-quote trigger, tenancy client extension, RBAC helper, cross-tenant tests. |
| `apps/web`          | React Router 7 app: landing, public calculator, email signup, health check. Rate-limited, Turnstile-ready, CSP with nonces.                                                         |
| `apps/worker`       | BullMQ jobs: FX refresh (HMRC + ECB), nightly tariff cache warm, hourly quote expiry.                                                                                               |
| `infra/terraform`   | Skeleton for a private R2/S3 bucket; no state, no credentials.                                                                                                                      |
| `docs/`             | Brief copy, ADRs 0001–0009, runbooks, decisions needed.                                                                                                                             |

Known placeholders (see [`docs/decisions-needed.md`](docs/decisions-needed.md)): rate sheet v1
figures, sample FX rates, hand-authored tariff API fixtures (the build sandbox could not reach the
live APIs), Turnstile/Redis/Postgres optional in dev.

## Quick start

```bash
corepack enable                      # pnpm 10 from packageManager field
pnpm install
pnpm --filter @harbour/db run generate
pnpm test                            # engine, adapters, db (pure), web, worker
pnpm dev                             # http://localhost:5173/calculator
```

Optional services: Postgres 16 (`DATABASE_URL`) for the db package's cross-tenant tests and
migrations (`pnpm db:migrate`), Redis 7 (`REDIS_URL`) for the worker and the Redis-backed rate
limiter. Copy `.env.example` to `.env`; never commit `.env`.

## Repository layout

```
apps/web          React Router 7 (framework mode) — Phase 0 calculator, Phase 1 workspace (TODO)
apps/worker       BullMQ workers and schedules
packages/engine   Pure engine (no I/O). Start here.
packages/adapters Tariff / FX / freight adapters, resilience primitives, rate sheets, fixtures
packages/db       Prisma schema, migrations, RLS, tenancy extension, RBAC
docs/             Brief, ADRs, runbooks, open decisions
infra/terraform   Infra skeleton
```

## Non-negotiables in code

- **Money is never `number`.** `Decimal` in code, decimal strings at boundaries, `Decimal` columns
  in Postgres. ESLint rule `harbour/no-number-money` and the engine's `D()` enforce it (ADR-0003).
- **Fail closed.** Missing/ambiguous tariff, FX or freight → `INDICATIVE`, never a silent 0% or 500.
- **Tenant isolation is absolute.** Prisma tenancy extension + Postgres RLS + RBAC + negative tests.
- **Quotes are immutable once accepted.** Postgres trigger; snapshots, not references.
- **Every external call** has a timeout, retries with jitter, a breaker and a labelled fallback.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the definition of done and migration rules.
