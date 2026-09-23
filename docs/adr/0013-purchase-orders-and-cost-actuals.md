# 0013. Purchase orders and estimate-to-actual reconciliation

- **Status:** Proposed. Scheduled as Phase 1 milestones M7 (purchase orders) and M8 (actuals
  and variance), after M4 quotes and M3 suppliers (ADR-0012).
- **Date:** 2026-09-23
- **Brief:** §1 (quotes are immutable snapshots), §4, §5.3 (customs value), §5.7 (FX), §7.2

## Context

A purchase order records what the importer agreed to buy: supplier, products, quantities, unit
prices and payment terms. A quote records what it will cost to ship and clear those goods.
Linking them lets the builder generate a quote with no retyping, and lets the dashboard compare
estimated with actual costs once invoices arrive.

## Decision

### `PurchaseOrder`

- `poNumber` unique per organisation, generated from a per-organisation sequence
  (`PO-2026-001`) and editable while `DRAFT`.
- `supplierId`, and `pickupLocationId` (ADR-0012) for the origin port.
- `currency` copied from the supplier's default and editable; `incoterm` as the existing
  `Incoterm` enum, not free text.
- `status` enum: `DRAFT`, `ISSUED`, `IN_PRODUCTION`, `READY_TO_SHIP`, `SHIPPED`, `CLOSED`,
  `CANCELLED`. **Changed:** payment and transit are not statuses. Deposit and balance have their
  own amount and paid-at fields, because a PO can be in production with the deposit unpaid.
  Transit and delivery belong to the Phase 2 `Shipment`, which already has that state machine.
- The importer changes the status. Suppliers have no accounts, so "the factory marks it ready"
  means the importer records that the factory said so.
- Money: `Decimal(14,4)` in the PO currency for unit costs, `Decimal(14,2)` for totals.
  `totalGoodsValue` is computed from the lines and frozen when the PO is issued.
- Deposit and balance: `depositAmount` and `balanceAmount` are computed from the supplier's
  `PaymentTerms.depositPct` when the PO is issued and frozen with it. Paid-at timestamps are
  set by the user today and by the payments partner's webhook later (decision (p)).
- Issued POs are immutable except for status and payment fields, enforced by a trigger like
  accepted quotes.

### `PurchaseOrderItem`

`productId`, `quantity`, `unitCost`, plus snapshots of SKU and name. Weight, volume, HS code and
origin are **not** frozen on the PO. They are snapshotted onto `QuoteLine` when a quote is
created, so a corrected HS code in the catalogue reaches new quotes but never changes an
accepted one.

### Quote link

`Quote.purchaseOrderId` is optional (quotes without a PO stay possible). Several quotes per PO
are allowed; **at most one may be `ACCEPTED`**, enforced by a partial unique index. "Get freight
quote" builds the engine input from the PO lines (quantity × catalogue weight and volume, unit
cost in the PO currency) and the pickup location's port.

**Changed:** duty and VAT use the goods value converted at the **HMRC monthly rate for the
expected import month** (§5.7), not the rate at which the deposit was paid. Customs value
follows §5.3, not a plain CIF sum, and tariff data comes from the 24-hour cache rather than a
live call on every quote.

### `CostActual` (M8) — superseded by ADR-0014

One row per actual invoice line: `category` enum (`GOODS`, `FREIGHT`, `ORIGIN_FEES`,
`DESTINATION_FEES`, `DUTY`, `IMPORT_VAT`, `DEFERMENT_FEE`, `INSURANCE`, `OTHER`), amount,
currency, GBP amount at the rate actually charged, optional `documentId` (the invoice in the
vault), linked to the PO and the accepted quote. Variance is computed per category against the
quote's snapshot, never by editing the quote.

### Tenancy

`PurchaseOrder`, `PurchaseOrderItem` and `CostActual` carry `organizationId`, composite foreign
keys, row-level security and tenancy allow-list entries (ADR-0009).

## Consequences

- The "pay the deposit now" prompt and FX revenue need the payments partner (decisions
  (p)–(q)). Until then the dashboard shows what is due and when, and the user records payment.
- Variance reporting depends on users entering actual invoices. M8 includes an invoice upload
  that pre-fills amounts for the user to confirm; automatic invoice reading is a later option.
