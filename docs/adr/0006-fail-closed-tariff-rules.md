# 0006. Fail-closed tariff resolution rules

- **Status:** Accepted (the VAT-assumed rule is flagged for confirmation)
- **Date:** 2026-09-23
- **Brief:** §5.2 (HS handling), §8 (failsafes)

## Context

The brief's rule is absolute: never silently default a duty rate to 0%. The UK tariff returns a
list of _measures_ per commodity and origin; the engine has to decide, for each combination it
can meet, whether it has enough certainty to price it. Where it does not, the quote must be
`INDICATIVE` with a visible reason.

## Decision

Implemented in `packages/engine/src/tariff.ts` (`resolveTariff`, `parseDutyExpression`) and
`packages/engine/src/hs.ts` (`normaliseHsCode`).

| Situation                                                                                                                       | Outcome                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| No third-country duty measure (103) for the origin                                                                              | `TARIFF_AMBIGUOUS` (blocking). Duty shown as 0 **with a banner**; never `READY`.                                                     |
| More than one 103 measure with different expressions                                                                            | `TARIFF_AMBIGUOUS`                                                                                                                   |
| Duty expression contains `MAX` / `MIN` clauses                                                                                  | `TARIFF_AMBIGUOUS`                                                                                                                   |
| Specific duty in a unit outside the conversion table (kg, 100 kg, 1000 kg, tonne, p/st, 100 p/st, 1000 p/st)                    | `TARIFF_AMBIGUOUS`                                                                                                                   |
| Anti-dumping / countervailing (551–554) that is not a simple ad valorem rate                                                    | `TARIFF_AMBIGUOUS` (specific-rate ADD is not supported in v1)                                                                        |
| Several exporter-specific ADD/CVD rates                                                                                         | Highest applied, `ADD_APPLIES` + `ADD_RATE_MAX_ASSUMED`                                                                              |
| No VAT measure (305)                                                                                                            | 20% assumed, `VAT_ASSUMED_STANDARD` (non-blocking; conservative direction)                                                           |
| Several VAT rates                                                                                                               | Highest applied, `VAT_RATE_MAX_ASSUMED`                                                                                              |
| Preference (142) exists and origin matches (directly or as a listed member of the area) **and** user ticked `preferenceClaimed` | Preferential rate applied                                                                                                            |
| Preference exists, origin matches, not claimed                                                                                  | Third-country rate, `PREFERENCE_AVAILABLE`                                                                                           |
| Claimed but no preferential measure for the origin                                                                              | Third-country rate, `PREFERENCE_NOT_ELIGIBLE`                                                                                        |
| Several preferential rates for the origin                                                                                       | Third-country rate, `PREFERENCE_AMBIGUOUS`                                                                                           |
| Specific or compound duty                                                                                                       | Computed on the product weight/quantity as entered, `SPECIFIC_DUTY_WEIGHT_BASIS` (HMRC assesses on net weight)                       |
| Quota (122/123/143) or excise (306) measures present                                                                            | `QUOTA_APPLIES` / `EXCISE_APPLIES`; full rate assumed, excise not included                                                           |
| 6/8-digit HS code mapping to several 10-digit children                                                                          | `AMBIGUOUS`: user must pick, **even when all children carry the same duty** — the declared code matters beyond duty (ADD, licensing) |

Measures are filtered by geographical area (`1011` ERGA OMNES, the origin itself, or a listed
group member) and by effective date before any of the rules above apply.

## Consequences

- Every gap in the tariff data produces a visible, testable warning; fixtures 10–19 in
  `packages/engine/fixtures/quotes/` cover each row.
- The 20%-assumed VAT rule is the one place we choose a rate rather than block. It errs high
  (VAT is recoverable for registered importers and over-stating is safer than under-stating)
  but it is a policy choice: recorded as open question (c) in `docs/decisions-needed.md`.
- The HS normalisation rule is stricter than the brief's minimum ("different duties"). Relaxing
  it needs customs-practitioner sign-off and a `CALC_VERSION` bump.
- Supporting MAX/MIN expressions and specific-rate ADD is a known gap for certain agricultural
  and steel lines; those quotes are `INDICATIVE` until the parser grows.
