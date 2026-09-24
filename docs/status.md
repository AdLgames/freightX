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

| Milestone                       | State                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| M5 document vault               | Built and verified in its branch; merge resolved, final checks running before push                                 |
| M2 settings and customs profile | Built and verified in its branch (encryption, wizard, company lookup, members, invitations, audit log); merge next |

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

## Handoff: M7 purchase orders (work in progress)

_Last updated: M7 code landed as WIP; tests and verification outstanding._

**Done (on `claude/new-session-ar961c`, unverified against a database):** migration `0012_purchase_orders` (tables, `po_counters`, triggers, RLS, one-accepted-quote-per-PO index) with its migration test; RBAC `order.view/edit/issue`; services `apps/web/app/services/orders/{orders,editor,freight-quote}.server.ts` and pure `schedule.ts`; validators `validators/order.ts`; components `components/orders/*`; routes `/app/orders`, `/app/orders/new`, `/app/orders/:id`, `/app/orders/:id/edit`; quote builder `?po=<id>` pre-fill and `Quote.purchaseOrderId` on save; Home "Payments due" card; Orders nav entry. Unit tests for `schedule.ts` and `validators/order.ts` pass; prettier and typecheck pass.

**Still to do for M7:**

1. DB-backed test `apps/web/app/routes/orders.db.test.ts` (mirror `quotes.db.test.ts`): numbering `PO-YYYY-001/002` per org and year incl. two parallel creates; create/update totals; issue freezes totals and computes deposit/balance for PREPAID, NET and DEPOSIT_BALANCE; trigger refuses editing an issued PO's lines/totals but allows status, payment dates and notes; illegal transition refused; second ACCEPTED quote refused (`PO_QUOTE_ACCEPTED`); `?po=` pre-fills the builder (quantity, PO unit cost) and the saved quote carries `purchaseOrderId`; cross-tenant negatives; RBAC (VIEWER cannot edit, MEMBER cannot issue); no PII in logs.
2. Run the full gate from the repo root with a Postgres cluster (migrate deploy 0001–0012; suite as superuser and as `harbour_app`): `pnpm exec prettier --check .`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test`, web and worker builds. Fix whatever fails.
3. Curl walkthrough of the built server: supplier with DEPOSIT_BALANCE 30% terms → product → PO of 500 units → issue → deposit due → record deposit paid → Get freight quote → save draft → PO detail lists the quote → Home shows the balance due.
4. Docs: `apps/web/README.md` "Orders (M7)" section, `packages/db/README.md` 0012 note, `docs/phase-1-build-plan.md` M7 → Done, move M7 to Completed above, `docs/decisions-needed.md` row (ag) "PO numbering per year vs global; deposit due date rule".

**Then M8** (bills / AP ledger UI and variance screens using `absorbActuals`, ADR-0014), followed by the housekeeping items listed in the plan (drop `Supplier.countryCode`, tighten the flaky M2 settings tests, tracking retention purge, worker DB role split).
