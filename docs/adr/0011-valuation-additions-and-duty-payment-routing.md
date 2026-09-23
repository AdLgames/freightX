# 0011. Valuation additions and duty payment routing

- **Status:** Proposed — fee terms, VAT-base padding figures and the assist method need the
  customs practitioner's review (decisions (l)–(n))
- **Date:** 2026-09-23
- **Brief:** §5.3 (customs value), §5.5 (incoterms), §5.10 (golden tests), §6.1 (booking preconditions)

## Context

A broker review of the calculator raised cases the engine did not model: tooling and moulds paid
to the supplier separately (assists), postponed VAT accounting (PVA), the fee a forwarder charges
for paying duty through its own deferment account, and the VAT base when UK inland costs are
unknown. Duty payment routing also matters for Phase 2: under CDS a forwarder cannot use the
importer's Deferment Approval Number (DAN) until the importer authorises the forwarder's EORI in
their CDS account.

## Decision

Engine `CALC_VERSION` 1.1 (`packages/engine/src/compute.ts`). Existing inputs give unchanged
money outputs; golden fixtures 01–28 changed only by the version stamp and new zero fields.

- **Assists.** `LineInput.assistsGbp` is the assist value apportioned to this line's units in this
  shipment. It is added to the customs value (so it attracts duty, and VAT through the customs
  value) and to landed cost. The engine does not decide how an assist is spread across future
  shipments; the caller does (the calculator offers cost × shipment units ÷ lifetime units).
- **Postponed VAT accounting.** `vatPostponed` is honoured only when `vatRegistered`; otherwise
  `PVA_REQUIRES_VAT_REGISTRATION` and VAT stays payable at the border. PVA never changes VAT or
  landed cost. It changes `totals.borderOutlay` (duty + VAT payable at the border).
- **Broker deferment fee.** `brokerDeferment { feePct, minimumGbp }` gives
  fee = max(minimum, feePct × borderOutlay), and 0 when nothing is advanced. It is allocated to
  lines by their share of the outlay and included in landed cost. It is not in the import VAT
  base. Terms are forwarder-specific, so no default figure is built in.
- **Inland VAT adjustment.** `inlandVatAdjustmentGbp` is added to the VAT base only when the
  freight source did not provide the UK post-border leg and the buyer pays for it. It is never
  added to landed cost, and warning `INLAND_VAT_ADJUSTMENT` says UK delivery is excluded. No
  default figure is built in; the web app reads per-mode figures from configuration.
- **Payment routing (schema).** `CustomsProfile` holds `paymentMethod` (`OWN_DEFERMENT`,
  `BROKER_DEFERMENT`, `CDS_CASH_ACCOUNT`), `usePva`, `danNumber`, `cdsAuthorityGranted` and the
  forwarder's fee terms. The database rejects PVA without a VAT registration and own deferment
  without a DAN.
- **Phase 2 booking preconditions (§6.1) gain two items**, design only: own deferment requires
  `cdsAuthorityGranted`, and PVA requires a VAT registration.

## Consequences

- Seven new golden fixtures (29–35), each with a hand calculation, cover the broker's tests
  (see `docs/broker-test-plan.md`).
- The property test "landed cost is monotonic in quantity" now holds only for quotes whose lines
  share a tariff. With mixed rates, adding units to a low-rate line shifts shared costs off a
  high-rate line and total tax can fall. That is correct behaviour, not a bug.
- A quote's routing is snapshotted on the quote (`payment_method`, `vat_postponed`), so an
  accepted quote keeps the assumptions it was priced on.
