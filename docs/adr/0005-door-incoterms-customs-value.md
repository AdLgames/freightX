# 0005. Customs value under door incoterms (DAP, DPU, DDP)

- **Status:** Proposed — awaiting customs-practitioner confirmation (`docs/decisions-needed.md`)
- **Date:** 2026-09-23
- **Brief:** §5.3 (customs value), §5.5 (incoterm branching), §10 #4

## Context

Under DAP and DPU the supplier's invoice price includes carriage to the UK door. The brief says
"freight = 0 in our calc; customs value still needs a freight element → require user to enter
supplier's freight portion or emit `INCOTERM_FREIGHT_UNKNOWN`". Two readings are possible:

1. The invoice price already contains freight to the border, so the customs value is the
   invoice price _less_ the supplier's post-border (UK) leg, which is not dutiable.
2. The invoice price is treated as a goods-only value and a freight element must be _added_.

Reading 2 double-counts the to-border freight already inside the price. Reading 1 matches how
customs value is generally established when the price includes delivery: post-importation
transport is deductible when shown separately. It is nonetheless a judgement the customs
practitioner must confirm.

## Decision

Implemented in `packages/engine/src/compute.ts` and `packages/engine/src/incoterm.ts`
(`INCOTERM_PLANS`); fixtures 06–09 in `packages/engine/fixtures/quotes/`.

- `unitValue` is the invoice price **as agreed**, including delivery. Goods value in GBP is
  quantity × unit value × FX rate, unchanged by incoterm.
- **DAP / DPU.** The buyer pays no freight, origin or destination fees in our calculation
  (clearance fee still applies). The user enters the supplier's freight breakdown
  (`supplierFreight.totalGbp` and, optionally, `postBorderGbp`):
  - Customs value = goods value − supplier's post-border portion (allocated to lines by
    goods-value share, ADR-0004). VAT base = customs value + duty + the post-border portion
    added back + clearance.
  - Breakdown with only a total: the whole amount is treated as to-border, so post-border = 0
    and customs value = full invoice value (the conservative, higher-duty direction); warning
    `FREIGHT_SPLIT_ASSUMED`.
  - No breakdown at all: warning `INCOTERM_FREIGHT_UNKNOWN` (blocking). The quote is computed
    on the full invoice value so the user still sees a figure, but it stays `INDICATIVE`.
  - A post-border figure that is negative, exceeds the total, or exceeds total goods value is
    rejected as a validation failure.
- **DDP.** Duty and import VAT are computed for information only and reported as
  supplier-borne (`DDP_SUPPLIER_BEARS_DUTY`); they are excluded from the buyer's totals and
  `vatRecoverable` is `false` regardless of VAT registration, because the buyer is not the
  importer of record and cannot use postponed VAT accounting on the supplier's entry.

## Consequences

- No double-counting of freight for DAP/DPU; the only way the customs value drops below the
  invoice price is a supplier-stated UK leg.
- The conservative fallback means an incomplete breakdown can only over-state duty, never
  under-state it, consistent with "fail closed on money".
- If the practitioner rules that the UK leg is not deductible in the way modelled, or that
  additional adjustments apply (e.g. buying commission, assists), this ADR is superseded and
  `CALC_VERSION` is bumped; fixtures 06–09 are the regression set.
