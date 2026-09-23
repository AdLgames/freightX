# 0014. Actual costs as an accounts payable sub-ledger

- **Status:** Proposed. Supersedes the `CostActual` section of ADR-0013. Built in Phase 1
  milestone M8.
- **Date:** 2026-09-23
- **Brief:** §1 (snapshots), §3 (money as Decimal), §5.3–§5.4 (customs value, apportionment),
  §7.2 (tenancy)

## Context

The purchase order and the accepted quote are the standard cost. Actual costs arrive as a set of
separate bills: the supplier's commercial invoice, the forwarder's freight invoice, and customs
charges from the broker or HMRC. Variance and true landed cost per SKU need those bills mapped
back to the purchase order lines they paid for.

## Decision

### Bills and lines

- `Bill`: vendor (`vendorType` enum `SUPPLIER`, `FORWARDER`, `CUSTOMS_BROKER`, `HMRC`, `OTHER`;
  `supplierId` when the vendor is a supplier; `vendorName` otherwise), `billType` enum
  (`SUPPLIER_INVOICE`, `FREIGHT_INVOICE`, `CUSTOMS_CHARGES`, `CUSTOMS_STATEMENT`, `OTHER`),
  `referenceNumber`, issue and due dates, `currency`, `totalAmount`, `isCreditNote`, `status`
  (`DRAFT`, `POSTED`, `PAID`), optional `documentId` for the invoice in the vault.
- A bill's reference is unique per vendor within an organisation, which catches duplicates.
- `BillLine`: `costCategory`, description, `amount` in the bill currency, and the **costing
  link**: `purchaseOrderId`, and optionally `purchaseOrderItemId` when the cost belongs to one
  SKU.
- On posting, a trigger checks that the lines add up to the bill total. Posted bills are
  immutable; corrections are credit notes, as in any AP ledger.

**Changed: the costing link sits on the line, not the bill, and bills do not need a shipment.**
Shipments are Phase 2 and have no code yet, so bills attach to purchase orders. HMRC's monthly
statements (import VAT certificate C79, the postponed import VAT statement, the duty deferment
statement) cover many imports, and one forwarder invoice can cover two purchase orders.
Line-level links let one bill be split across several orders. When Phase 2 lands, lines gain an
optional `shipmentId`.

### Payments and exchange rates

`BillPayment` (one bill to many): `paidAt`, `amount` in the bill currency, `fxRate`,
`amountGbp`.

**Changed: exchange rates live on payments, not on the bill.** A supplier invoice paid as a 30%
deposit and a 70% balance is paid at two different rates. The GBP cost of goods is the sum of
the payments' GBP amounts. Unpaid balances use the latest HMRC monthly rate, labelled as an
estimate.

### Cost categories match the quote snapshot

**Changed:** the categories line up one-to-one with the quote's stored totals, so each variance
is a direct subtraction: `GOODS`, `ASSISTS`, `FREIGHT_TO_BORDER`, `FREIGHT_POST_BORDER`,
`ORIGIN_FEES`, `DESTINATION_FEES`, `CLEARANCE`, `INSURANCE`, `DUTY`, `IMPORT_VAT`,
`DEFERMENT_FEE`, `UNPLANNED` (with an `unplannedReason` enum: `DEMURRAGE`, `DETENTION`,
`STORAGE`, `CUSTOMS_EXAMINATION`, `OTHER`), `OTHER`. Enums are additive only.

### Variance

Per category: actual (GBP) minus estimate (GBP), shown as favourable or unfavourable. For goods
priced in a foreign currency, the variance splits into:

- **price variance:** actual invoice amount minus PO amount, both at the quote's rate;
- **FX variance:** invoice amount × (payment rate − the quote's rate).

Freight is estimated in GBP, so a freight bill in USD shows its total GBP variance with a note
that it was billed in USD. There is no invented FX split for freight.

### Cost absorption per SKU

- **Import VAT is excluded only when it is recoverable** (the organisation is VAT registered).
  **Changed:** for an importer who is not VAT registered, import VAT is a real cost and stays in.
- Costs linked to a PO item go to that SKU.
- Duty not itemised per SKU is apportioned by each line's **customs value share**. **Changed:**
  not by volume, because duty rates differ between SKUs and volume would move duty onto
  low-rate goods.
- Freight, origin, destination, clearance and unplanned costs are apportioned by the same
  chargeable-weight basis the engine used for the estimate: sea max(tonnes, CBM), air max(kg,
  volumetric at 1:6000). Insurance goes by value.
- Every split uses the engine's largest-remainder `allocate`, so SKU costs add up to the bills to
  the penny.
- The result is actual landed cost per unit next to the quoted figure, such as £4.50 quoted
  against £5.12 actual.

The absorption and variance maths is a pure function in `packages/engine` (an `actuals` module)
with its own golden fixtures, like the quote engine.

### Tenancy

`Bill`, `BillLine` and `BillPayment` carry `organizationId`, composite foreign keys, row-level
security and tenancy allow-list entries (ADR-0009). Bills are financial records, so posting,
paying and credit notes write audit log entries.

## Consequences

- Monthly HMRC statements need a "split across orders" step in the UI. It pre-fills from the
  customs entries the forwarder reports and the user confirms it.
- A later export to Xero or QuickBooks maps naturally from posted bills.
- Variance is only as good as the bills entered. The dashboard shows how complete each order's
  actuals are, for example "freight bill missing", before it shows a variance.
