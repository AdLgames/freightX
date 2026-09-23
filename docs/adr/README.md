# Architecture decision records

Short, dated records of decisions that shape the codebase. Each ADR is immutable once
accepted; a change of mind gets a new ADR that supersedes the old one.

## Index

| ID                                                                | Title                                                          | Status   | Date       |
| ----------------------------------------------------------------- | -------------------------------------------------------------- | -------- | ---------- |
| [0001](0001-prisma-6-over-7.md)                                   | Prisma 6.19.x rather than 7/8                                  | Accepted | 2026-09-23 |
| [0002](0002-react-router-7-framework-mode.md)                     | React Router 7 framework mode for "Remix"                      | Accepted | 2026-09-23 |
| [0003](0003-money-as-decimal-strings-at-boundaries.md)            | Money as `Decimal`, decimal strings at boundaries              | Accepted | 2026-09-23 |
| [0004](0004-apportionment-largest-remainder.md)                   | Apportionment by chargeable weight, largest-remainder rounding | Accepted | 2026-09-23 |
| [0005](0005-door-incoterms-customs-value.md)                      | Customs value under DAP/DPU/DDP                                | Proposed | 2026-09-23 |
| [0006](0006-fail-closed-tariff-rules.md)                          | Fail-closed tariff resolution rules                            | Accepted | 2026-09-23 |
| [0007](0007-blocking-warning-set.md)                              | The blocking warning set                                       | Proposed | 2026-09-23 |
| [0008](0008-phase-0-fx-and-tariff-sources.md)                     | Phase 0 FX and tariff sources                                  | Accepted | 2026-09-23 |
| [0009](0009-tenancy-defence-in-depth.md)                          | Tenancy defence in depth                                       | Accepted | 2026-09-23 |
| [0010](0010-sailing-schedules-read-only.md)                       | Sailing schedules: read-only visibility before booking         | Proposed | 2026-09-23 |
| [0011](0011-valuation-additions-and-duty-payment-routing.md)      | Valuation additions and duty payment routing                   | Proposed | 2026-09-23 |
| [0012](0012-supplier-legal-vs-physical-and-payments-readiness.md) | Supplier legal vs physical entity; payments readiness          | Proposed | 2026-09-23 |
| [0013](0013-purchase-orders-and-cost-actuals.md)                  | Purchase orders and estimate-to-actual reconciliation          | Proposed | 2026-09-23 |

"Proposed" ADRs record what the code does today but await confirmation from the founder or the
customs practitioner (see `docs/decisions-needed.md`).

## Writing a new ADR

1. Copy the template below to `NNNN-short-kebab-title.md` with the next number.
2. Keep it under a page. Link to code, fixtures or brief sections rather than restating them.
3. Open a PR; the ADR is "Accepted" when the PR merges. If it changes a formula, the same PR
   bumps `CALC_VERSION` in `packages/engine/src/version.ts`.
4. To reverse a decision, write a new ADR with `Supersedes: NNNN` and mark the old one
   `Superseded by NNNN`.

## Template

```markdown
# NNNN. Title

- **Status:** Proposed | Accepted | Superseded by NNNN
- **Date:** YYYY-MM-DD
- **Brief:** §x.y (sections this decision interprets)

## Context

What situation forced a decision. Facts, constraints, what the brief says.

## Decision

What we do, stated in the present tense. Point at the code that implements it.

## Consequences

What becomes easier, what becomes harder, what must be revisited and when.
```
