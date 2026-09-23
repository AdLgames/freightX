# 0003. Money as `Decimal`, decimal strings at boundaries

- **Status:** Accepted
- **Date:** 2026-09-23
- **Brief:** §3 ("Never `number` for money"), §4 (Decimal columns), §8 (money precision)

## Context

Landed-cost figures pass through forms, JSON, the engine, Prisma and back to the browser.
JavaScript `number` cannot represent 0.1 exactly and silently loses precision above 2^53. A
single `number` sneaking into a duty calculation would be invisible until a golden test caught
it, and the brief requires a lint rule as well as `Decimal` types.

## Decision

- The engine (`packages/engine`) computes with `decimal.js` using a cloned constructor with
  precision 40 and `ROUND_HALF_UP` (`packages/engine/src/money.ts`). Pennies are rounded with
  `round2`, unit values and per-unit landed cost with `round4`.
- Money crosses every boundary — form data, JSON, adapter responses, engine input and output,
  fixtures — as a **canonical decimal string** such as `"5180.20"`, never as a `number`.
  Engine output uses `fixed2`/`fixed4` so the string is already rounded.
- Prisma columns are `Decimal` with the scales in the brief; Prisma's `Decimal` is converted
  with `.toString()` before it reaches the engine and constructed from the engine's strings
  when persisting.
- `D()` in the engine rejects anything that is not a `string` or `Decimal` with a `TypeError`,
  and rejects strings that are not plain decimals (no exponents, no thousands separators).
- A custom ESLint rule, `harbour/no-number-money`, reports any identifier, property or
  parameter whose name matches money patterns (`*Gbp`, `*Value`, `*Cost`, `*Fee*`, `*Price`,
  `*Duty*`, `*Vat*`, `*Premium`, `*Amount`, `rate*`) when it is typed or initialised as a
  `number`. `pnpm run lint` runs with `--max-warnings 0`.

## Consequences

- No floating-point money anywhere; the property tests in `packages/engine/test` assert that
  totals equal the sum of lines to the penny.
- Strings are slightly awkward to write in tests, which is intentional: it makes a `number`
  literal stand out in review.
- Quantities and percentages that are genuinely integers or rates (e.g. `quantity`) remain
  `number`; the lint rule's name patterns are the contract for what counts as money, and any
  extension to them is a lint-rule change reviewed like a formula change.
