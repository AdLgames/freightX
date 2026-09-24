# Build status

- **As of:** 2026-09-24
- **Branch:** `claude/new-session-ar961c` (PRs #1 and #2 merged to `main`; later work on the branch)
- **Plan:** `docs/phase-1-build-plan.md` · **Brief:** `docs/engineering-brief.md`

## Completed

| Area                 | What exists                                                                                                                                                                                                              | Verified                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Engine 1.1           | Landed cost per unit, HS normalisation, tariff measures, incoterms, apportionment, assists, PVA, deferment fee, inland VAT padding; `absorbActuals` for estimate-to-actual variance                                      | 35 golden fixtures with hand calculations, property tests                                     |
| Adapters             | UK Trade Tariff client and cache, HMRC/ECB FX, rate sheet v1, circuit breaker, SeaRates and schedules stubs, Companies House and HMRC identity checkers, object storage (R2/S3 and local)                                | Unit and contract tests on hand-authored fixtures                                             |
| Database             | Prisma schema, migrations 0001–0008, row-level security, accepted-quote lock, tenancy client, RBAC, field encryption                                                                                                     | Tests run against Postgres 16 as superuser and as the app role                                |
| Worker               | FX refresh, tariff warm, quote expiry, identity verification, document scan, Stripe events                                                                                                                               | Tests; runs without Redis via `--once`                                                        |
| Phase 0 calculator   | Public calculator with tooling/assists, duty payment routing, PVA, live tariff lookup, rate limits, Turnstile, CSP                                                                                                       | Deployed on Vercel (stopgap host)                                                             |
| M1 sign-in and shell | Magic links, Redis sessions, CSRF, organisations, memberships, onboarding, org switcher                                                                                                                                  | Full flow driven on the built server                                                          |
| M3 catalogue         | Products, suppliers, pickup locations, payment terms, HS code lookup with official description                                                                                                                           | Merged and pushed                                                                             |
| M6 billing           | Stripe Checkout, Billing Portal, signed webhooks, plan limits (provisional)                                                                                                                                              | Merged and pushed                                                                             |
| Design system        | Landing page, sidebar workspace shell, Command Center home                                                                                                                                                               | Merged and pushed                                                                             |
| M4 quote builder     | Builder with live breakdown, saved snapshots, finalise/accept/cancel, quotes list, Home widgets                                                                                                                          | Merged and pushed                                                                             |
| M9 tracking          | Containers, milestone webhooks, per-vessel polling, lane-aware dead reckoning, MapLibre and Deck.gl map (Phase 2, started early)                                                                                         | Merged and pushed                                                                             |
| M7 purchase orders   | Migration 0012, `PO-YYYY-NNN` numbering, editor from the catalogue, issue and freeze, deposit/balance schedule from payment terms, payments by date, "Get freight quote", one accepted quote per PO, Home "Payments due" | DB test as superuser and `harbour_app`; full gate green; curl walkthrough on the built server |

## In progress

| Milestone                    | State                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M8 actual costs and variance | Built: migration 0013, bills ledger (drafts, posting, frozen, payments with FX), "Costs and variance" per order through the engine's `absorbActuals`; DB test as superuser and `harbour_app`; gate green; walkthrough on the built server. Left: see the handoff |

## Not started

| Milestone                     | Notes                                                 |
| ----------------------------- | ----------------------------------------------------- |
| Supplier payments (ADR-0016)  | Waits on Airwallex and counsel confirmations          |
| Trade finance gate            | Waits on counsel; Companies House data captured by M2 |
| Phase 2 booking               | Gated on the forwarder agreement (brief §2)           |
| Passkeys and TOTP MFA         | Brief §7.1; MFA required before booking and payments  |
| Data export and deletion jobs | Brief §7.3                                            |

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

## Handoff: M8 actual costs and variance (built, slice 1)

_Last updated: M7 complete and verified; M8 built and tested, a few pieces left._

**Done (on `claude/new-session-ar961c`):** migration `0013_bills` (enums `vendor_type`, `bill_type`, `bill_status`, `cost_category`, `unplanned_reason`; tables `bills`, `bill_lines`, `bill_payments` with composite FKs, CHECKs, reference-per-vendor partial indexes, triggers `bills_guard` / `bill_lines_frozen` / `bill_payments_guard`, RLS, grants) with its migration test; tenancy allow-list and Prisma exports; RBAC `bill.view/edit/post`; validators `validators/bill.ts`; services `services/bills/{bills,editor,variance}.server.ts` and pure `actuals.ts` / `totals.ts`; components `components/bills/*`; routes `/app/bills`, `/app/bills/new`, `/app/bills/:id`, `/app/bills/:id/edit`, `/app/orders/:id/costs`; "Costs and variance" and "Record a bill" links on the purchase order page; Bills nav entry. Tests: `validators/bill.test.ts`, `services/bills/actuals.test.ts`, `routes/bills.db.test.ts` (both database roles). Docs: web README "Bills and variance (M8)", db README 0013, decisions-needed (ah).

**Still to do for M8:**

1. Attach the invoice from the vault to a bill (`Bill.documentId` and the composite FK exist; add a picker on the bill page using M5's `loadVault`, and a "record a bill from this document" link on the vault).
2. Home: an "Actuals" card (orders with posted bills, biggest variance, categories still missing) next to "Payments due".
3. ADR-0014 consequences: the "split an HMRC statement across orders" helper (pre-fill lines from the orders' customs values) and, later, the Xero/QuickBooks export of posted bills.
4. Decide decisions-needed (ah) (rate for the unpaid part of a foreign-currency bill; reference uniqueness) and adjust `billsToActuals` if the answer differs.

**Then** the housekeeping items listed in the plan (drop `Supplier.countryCode`, tighten the flaky M2 settings tests, tracking retention purge, worker DB role split).

**Note on the test database:** running the suite as `harbour_app` leaves tracking and ledger organisations behind (the app role cannot delete append-only or frozen rows), and a later superuser run of `packages/db/test/tracking.db.test.ts` then fails on the leftovers. Use a fresh database per role, as CI does.
