# Build status

- **As of:** 2026-09-23
- **Branch:** `claude/new-session-ar961c` (PRs #1 and #2 merged to `main`; later work on the branch)
- **Plan:** `docs/phase-1-build-plan.md` · **Brief:** `docs/engineering-brief.md`

## Completed

| Area                 | What exists                                                                                                                                                                               | Verified                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Engine 1.1           | Landed cost per unit, HS normalisation, tariff measures, incoterms, apportionment, assists, PVA, deferment fee, inland VAT padding; `absorbActuals` for estimate-to-actual variance       | 35 golden fixtures with hand calculations, property tests      |
| Adapters             | UK Trade Tariff client and cache, HMRC/ECB FX, rate sheet v1, circuit breaker, SeaRates and schedules stubs, Companies House and HMRC identity checkers, object storage (R2/S3 and local) | Unit and contract tests on hand-authored fixtures              |
| Database             | Prisma schema, migrations 0001–0008, row-level security, accepted-quote lock, tenancy client, RBAC, field encryption                                                                      | Tests run against Postgres 16 as superuser and as the app role |
| Worker               | FX refresh, tariff warm, quote expiry, identity verification, document scan, Stripe events                                                                                                | Tests; runs without Redis via `--once`                         |
| Phase 0 calculator   | Public calculator with tooling/assists, duty payment routing, PVA, live tariff lookup, rate limits, Turnstile, CSP                                                                        | Deployed on Vercel (stopgap host)                              |
| M1 sign-in and shell | Magic links, Redis sessions, CSRF, organisations, memberships, onboarding, org switcher                                                                                                   | Full flow driven on the built server                           |
| M3 catalogue         | Products, suppliers, pickup locations, payment terms, HS code lookup with official description                                                                                            | Merged and pushed                                              |
| M6 billing           | Stripe Checkout, Billing Portal, signed webhooks, plan limits (provisional)                                                                                                               | Merged and pushed                                              |
| Design system        | Landing page, sidebar workspace shell, Command Center home                                                                                                                                | Merged and pushed                                              |

## In progress

| Milestone                            | State                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| M5 document vault                    | Built and verified in its branch; merge resolved, final checks running before push                                   |
| M2 settings and customs profile      | Built and verified in its branch (encryption, wizard, company lookup, members, invitations, audit log); merge next   |
| M9 tracking (Phase 2, started early) | Being built: containers, milestone webhooks, per-vessel polling, lane-aware dead reckoning, MapLibre and Deck.gl map |

## Not started

| Milestone                            | Notes                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| M4 quote builder and Home widgets    | Needs the catalogue, now merged; quick duty check and recent-draft continuation |
| M7 purchase orders                   | ADR-0013; needs M3 and M4                                                       |
| M8 actual costs and variance screens | ADR-0014; the engine maths is done, the bills UI is not                         |
| Supplier payments (ADR-0016)         | Waits on Airwallex and counsel confirmations                                    |
| Trade finance gate                   | Waits on counsel; Companies House data captured by M2                           |
| Phase 2 booking                      | Gated on the forwarder agreement (brief §2)                                     |
| Passkeys and TOTP MFA                | Brief §7.1; MFA required before booking and payments                            |
| Data export and deletion jobs        | Brief §7.3                                                                      |

## Changed from the brief

| Change                                                                                                    | Where recorded          |
| --------------------------------------------------------------------------------------------------------- | ----------------------- |
| Prisma 6 rather than 7; React Router 7 framework mode for "Remix"                                         | ADR-0001, ADR-0002      |
| Apportionment uses largest-remainder rounding, not "remainder to the largest line"                        | ADR-0004                |
| DAP/DPU customs value = invoice minus the supplier's UK leg; DDP duty and VAT shown as supplier-borne     | ADR-0005 (proposed)     |
| Missing VAT measure assumes 20% with a warning; specific-rate anti-dumping blocks                         | ADR-0006                |
| `FREIGHT_UNAVAILABLE` added to the blocking set; `FREIGHT_FALLBACK` does not block                        | ADR-0007 (proposed)     |
| Engine 1.1: assists, postponed VAT, broker deferment fee, inland VAT padding                              | ADR-0011                |
| Supplier split into legal entity and pickup locations; no bank details stored, partner references only    | ADR-0012                |
| Purchase orders bridge suppliers and quotes; payment and transit are not PO statuses                      | ADR-0013                |
| Actual costs modelled as an AP sub-ledger with FX on payments                                             | ADR-0014                |
| Airwallex chosen; user-owned wallet; trade finance via partner lender for limited companies only          | ADR-0015, ADR-0016      |
| Tracking: one shipment timeline, per-vessel polling in the existing worker, capped dead reckoning         | ADR-0017                |
| Phase 1 and read-only tracking started before the Phase 0 gate, at the founder's request                  | Plan                    |
| Vercel hosts the calculator as a stopgap; move to Fly.io or Railway before Phase 1 goes live              | Decision (k)            |
| Landing copy describes a calculator and system of record, never a freight network; no invented statistics | `docs/design-system.md` |

## Open decisions

See `docs/decisions-needed.md` (rows (a)–(ad) plus milestone additions). The ones that block
launch: real rate sheet figures (d), customs practitioner review of the fixtures (4), email
provider (s), hosting (k), storage and scanning providers (x, y).
