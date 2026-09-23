# 0004. Apportionment by chargeable weight with largest-remainder rounding

- **Status:** Accepted
- **Date:** 2026-09-23
- **Brief:** §5.4 (apportioning shared costs)

## Context

Freight, origin and destination fees are shipment-level and must be allocated to lines so that
the allocations sum to the total to the penny. The brief says to allocate by chargeable-weight
share and to "allocate the rounding remainder to the largest line".

That rule is under-specified when shares are rounded half-up: each rounded share can already be
above or below its exact value, so the "remainder" may be negative and, on tiny totals with
many lines, larger in magnitude than the largest line's share. Example: £0.03 split over five
equal lines rounds half-up to £0.01 each (£0.05), leaving a remainder of −£0.02 which would
push the "largest" line to −£0.01.

Insurance, the platform fee and the supplier's post-border freight (DAP/DPU, ADR-0005) are also
shipment-level, but they are not weight-driven costs; allocating a _deduction_ by weight could
push a light, high-value line's customs value below zero.

## Decision

Implemented in `packages/engine/src/money.ts` (`allocate`) and
`packages/engine/src/apportion.ts`:

- **Basis.** Chargeable weight per line: sea/road/rail `max(tonnes, CBM)`; air
  `max(kg, CBM × 1,000,000 / 6000)`. The basis (`SEA_WEIGHT_OR_MEASURE` /
  `AIR_VOLUMETRIC_6000`) is stored on the quote.
- **Rounding.** Largest-remainder (Hamilton) method: every exact share is truncated to
  pennies, then the leftover pennies are handed out one at a time to the lines with the largest
  truncated fraction; ties go to the larger weight, then the earlier line. If all weights are
  zero the total is split equally. The function asserts that the shares sum to the total and
  that no share is negative.
- **Value-share allocations.** Insurance premium, platform fee and the supplier's post-border
  freight deduction are allocated by **goods-value share** using the same rounding method. A
  deduction allocated by value share can never exceed the line's goods value (the engine also
  rejects a supplier post-border figure larger than total goods value), so every line's customs
  value stays ≥ 0.

## Consequences

- For the common cases (£100 split three ways) the result is identical to the brief's rule:
  the largest line receives the extra penny.
- No share can be negative and the sum is exact by construction; this is covered by
  `test/apportion.test.ts`, `test/money.test.ts` and a fast-check property.
- Any change to the tie-break order changes penny placement on some quotes and is a formula
  change: bump `CALC_VERSION`.
- The brief's wording should be read as this ADR; the customs practitioner reviewing the golden
  fixtures does not need to re-derive it.
