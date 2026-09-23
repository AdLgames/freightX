# 0012. Supplier legal vs physical entity, and readiness for embedded payments

- **Status:** Proposed. Schema lands in Phase 1 milestone M3; no payment or finance code until
  a payments partner is signed and regulatory advice is taken (decisions (p)–(r)).
- **Date:** 2026-09-23
- **Brief:** §1 (never hold client money), §4 (data model), §7.2 (tenancy), §7.3 (PII
  minimisation: "we do not store supplier bank details")

## Context

Embedded FX payments to suppliers and trade finance (deposit and balance funding) are future
revenue lines. Both need the supplier's **legal entity**: the name, registration and country
that a payments partner screens for KYB and AML. Freight quoting needs the **physical entity**:
where the goods are collected and the nearest port. These often differ. A typical case is a Hong
Kong company that invoices and receives USD, with its factory in Shenzhen. The brief's
`Supplier` has one `countryCode`, which cannot hold both.

The proposed design also stored supplier bank account numbers on our side. That conflicts with
§7.3, and it would put us in scope for the controls that go with holding payment credentials.

## Decision

### Legal entity on `Supplier`

`legalName` (as registered), `tradingName`, `registrationNumber` (for example the Unified Social
Credit Code), `countryOfIncorporation` (ISO alpha-2), `defaultCurrency`. The existing
`countryCode` becomes `countryOfIncorporation`; the migration copies it across.

### Physical entity on `PickupLocation` (new, one supplier to many)

`name`, address lines, city, postcode, `country`, `closestPortCode` (UN/LOCODE, validated),
`isDefault`. The quote builder takes the origin port from the chosen pickup location instead of
asking for it. Pickup locations never decide the goods' origin for duty; that stays on
`Product.originCountry`, because origin follows where goods were made, not where they are
collected or invoiced.

### Payout methods as partner references only (changed)

`PayoutMethod` stores `partner` (for example `AIRWALLEX`), `partnerBeneficiaryId`, `type`
(`LOCAL`, `SWIFT`, and others as enums), `currency`, `bankCountry`, `bankName`,
`accountLast4` and `verifiedAt`. The account number, routing code and account name are
submitted straight to the partner's hosted beneficiary form or API and **never stored or logged
by us**. We keep the partner's reference and a masked display value, which keeps §7.3 intact and
keeps the platform out of scope for holding bank credentials.

### Payment terms (design now, used later)

`PaymentTerms` (one per supplier, overridable per quote later): `termType` enum (`PREPAID`,
`NET`, `DEPOSIT_BALANCE`), `depositPct` as `Decimal(5,2)` in percent ("30.00", matching the
engine's percent convention), `balanceTrigger` enum (`ON_SHIPMENT`, `AGAINST_BILL_OF_LADING`,
`ON_ARRIVAL`), `netDays`. Trade-finance products read these to know when capital is needed.

### Tenancy

`PickupLocation`, `PayoutMethod` and `PaymentTerms` carry a denormalised `organizationId`, a
composite foreign key to `(supplier_id, organization_id)`, row-level security, and entries in
the tenancy allow-list, like every other tenant table (ADR-0009). Status, type and trigger
fields are Postgres enums, which are additive only.

## Consequences

- Freight quoting gets the correct origin port and origin trucking from the pickup location.
- A payments partner can onboard beneficiaries from our legal-entity data without us holding
  bank details. Losing our database would not expose supplier accounts.
- Payments stay partner-led: the partner holds and moves funds; we never hold client money
  (§1). Adding payments or finance code is a new phase with its own ADR, after decisions
  (p)–(r).
- Trade finance for sole traders and partnerships can be FCA-regulated credit; lending to
  limited companies usually is not. This needs legal advice before any product design.
