# @harbour/engine — landed-cost engine

Pure TypeScript, **no I/O**. Takes resolved inputs (products, FX snapshot, freight quote, tariff
measures) and returns a `QuoteResult`. Everything that fetches lives in `@harbour/adapters`.

```ts
import { computeQuote } from '@harbour/engine';

const result = computeQuote(input); // { ok: true, quote } | { ok: false, stage, code, message }
```

## Pipeline position (§5.1)

```
resolveProducts → resolveFx → resolveFreight → resolveTariff → [ compute → validate ] → persist
                                                                 ^^^^^^^^^^^^^^^^^^ this package
```

Structurally impossible inputs (no lines, negative money, unknown currency) return
`{ ok: false }` with a stage and code. Everything else produces a quote; problems become warnings.

## Money

- Inputs and outputs are canonical decimal **strings** (`"5180.20"`); computation uses
  `decimal.js` with precision 40 and `ROUND_HALF_UP`. `number` is rejected at runtime by `D()`.
- Line money is rounded to pennies; unit values and per-unit landed cost to 4 dp.
- Shared costs are apportioned with the largest-remainder method so allocations always sum to the
  total exactly and are never negative (ADR-0004).

## Formulae (§5.3)

Per line, with allocations `alloc*` from §5.4:

```
lineGoodsValueGbp   = round2(round4(unitValue × fxRate) × quantity)
lineCustomsValue    = goods + allocOrigin + allocFreightToBorder + allocInsurance − allocSupplierPostBorder
lineDuty            = round2( adValorem(customsValue) + specific(weight | quantity) + ADD(customsValue) )
lineVatBase         = customsValue + duty + allocFreightPostBorder + allocDestination(+clearance) + allocSupplierPostBorder
lineVat             = round2(vatBase × vatRate)
lineLandedExVat     = goods + allocFreight(both legs) + allocOrigin + allocDestination + allocInsurance + duty + allocPlatformFee
landedCostPerUnit   = round4(lineLandedExVat / quantity)     (+ VAT variant)
```

Quote totals are sums of line values, so `Σ lines == totals` to the penny (property-tested).

### Apportionment basis

| Mode                            | Chargeable weight per line       |
| ------------------------------- | -------------------------------- |
| SEA_LCL / SEA_FCL / ROAD / RAIL | max(tonnes, CBM)                 |
| AIR                             | max(kg, CBM × 1,000,000 / 6,000) |

Freight (both legs), origin and destination fees are allocated by chargeable weight; insurance,
platform fee and the DAP/DPU supplier post-border deduction by goods-value share.

### Incoterms (§5.5)

See `src/incoterm.ts` — a reviewable data table. Highlights:

| Incoterm  | Buyer pays                                             | Customs value                                                                |
| --------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| EXW       | origin + freight + destination + clearance             | goods + origin + to-border freight + insurance                               |
| FCA / FOB | freight + destination + clearance (+ origin if stated) | goods (+ origin if stated) + to-border + insurance                           |
| CFR       | UK haulage + destination + clearance                   | goods + insurance                                                            |
| CIF       | UK haulage + destination + clearance                   | goods (buyer insurance ignored, `INSURANCE_IGNORED_CIF`)                     |
| DAP / DPU | clearance only                                         | goods − supplier's UK leg (needs breakdown, else `INCOTERM_FREIGHT_UNKNOWN`) |
| DDP       | nothing extra                                          | duty/VAT computed for information, reported as supplier-borne                |

The DAP/DPU reading is ADR-0005 and needs customs-practitioner sign-off.

## Tariff resolution (§5.2) — fail closed

`resolveTariff(measures, { originCountry, preferenceClaimed, asOf })`:

- `103` third-country duty is the default. None, or several disagreeing → `TARIFF_AMBIGUOUS` (blocking).
- `142` preference only if the origin matches (directly, or via listed group members, minus
  `excludedCountries`) **and** `preferenceClaimed`. Otherwise `PREFERENCE_AVAILABLE` / `PREFERENCE_NOT_ELIGIBLE`.
- `551–554` ADD/CVD: highest applicable ad valorem rate is added (`ADD_APPLIES`, `ADD_RATE_MAX_ASSUMED`);
  specific-rate ADD is unsupported → `TARIFF_AMBIGUOUS`.
- `305` VAT: highest rate present; none → 20% with `VAT_ASSUMED_STANDARD`.
- `122/123/143` → `QUOTA_APPLIES`; `306` → `EXCISE_APPLIES` (excise not computed).
- Duty expressions: ad valorem, specific (`£ x / kg | 100 kg | 1000 kg | p/st …`), compound.
  `MAX`/`MIN` clauses or unknown units → `TARIFF_AMBIGUOUS`. Never 0% by default.

## Status (§5.9)

Blocking warnings (→ `INDICATIVE`): `HS_UNVERIFIED`, `TARIFF_AMBIGUOUS`, `RATE_OUTLIER`,
`INCOTERM_FREIGHT_UNKNOWN`, `FREIGHT_UNAVAILABLE`. All others are informational (ADR-0007).

## Tests

- `test/golden.test.ts` — 28 scenarios in `fixtures/quotes/*.json`, each with a `notes` field
  holding the hand calculation. **Any change to `expected` is a formula change**: bump
  `CALC_VERSION`, get a customs practitioner to review (decision #4).
  Regenerate with `pnpm --filter @harbour/engine run fixtures:update`.
- `test/properties.test.ts` — fast-check invariants: totals = Σ lines, no negatives, monotonic in
  quantity, deterministic, DDP never charges the buyer duty/VAT.
- Unit tests for the duty-expression parser, measure resolution, HS normalisation, apportionment.

## Versioning

`CALC_VERSION` (`src/version.ts`) is stamped on every quote. Bump it whenever a money output can
change; old quotes keep the version that produced them.
