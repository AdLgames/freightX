# 0007. The blocking warning set

- **Status:** Proposed — founder to confirm the `FREIGHT_FALLBACK` reading
- **Date:** 2026-09-23
- **Brief:** §5.8, §5.9

## Context

§5.9 describes `INDICATIVE` as "computed but has a blocking warning (HS unverified, tariff
ambiguous, fallback rate, outlier)" and then gives an explicit list: "Blocking warnings:
`HS_UNVERIFIED`, `TARIFF_AMBIGUOUS`, `RATE_OUTLIER`, `INCOTERM_FREIGHT_UNKNOWN`. Non-blocking:
everything else." The prose mentions a fallback rate; the explicit list does not include
`FREIGHT_FALLBACK`. The two cannot both be followed.

Separately, the engine can be asked to compute with no freight rate at all (adapter outage and
no rate-sheet lane). The brief has no warning for that case.

## Decision

`packages/engine/src/warnings.ts` defines:

- **Blocking:** `HS_UNVERIFIED`, `TARIFF_AMBIGUOUS`, `RATE_OUTLIER`, `INCOTERM_FREIGHT_UNKNOWN`
  (the brief's list) plus `FREIGHT_UNAVAILABLE` (added: no rate could be resolved; using 0
  would violate "fail closed on money").
- **Non-blocking:** everything else, including `FREIGHT_FALLBACK`.

The explicit list was followed for `FREIGHT_FALLBACK` because (a) the explicit list reads as the
normative statement, (b) the rate sheet is the _only_ source in Phase 0, so treating it as a
blocker would make every Phase 0 quote `INDICATIVE`, and (c) the sheet is versioned and
labelled on the quote (`rateSource = "RATE_SHEET_Vn"`), so the user can see what they are
getting. Status derivation is a single function (`deriveStatus`): any blocking warning →
`INDICATIVE`, otherwise `READY`.

## Consequences

- Phase 1 quotes produced on a fallback rate during a SeaRates outage can reach `READY` and be
  accepted. If the founder considers that unacceptable, moving `FREIGHT_FALLBACK` into the
  blocking list is a one-line change plus fixture updates and a `CALC_VERSION` minor bump.
- `FREIGHT_UNAVAILABLE` is beyond the brief and is documented here so the practitioner and
  founder can see it; fixture 24 covers it.
- Any future warning must be added to exactly one of the two lists; the type system makes an
  unlisted code a compile error.
