# Phase 1 workspace UX spec

- **Status:** Draft, not built. Phase 1 starts after the Phase 0 gate (brief §2).
- **Date:** 2026-09-23
- **Relates to:** brief §1 non-negotiables, §6.1, §7.2 RBAC; ADR-0011 (payment routing, PVA)

Product copy and screen structure for the logged-in workspace. The notes marked **Corrected**
change the proposed copy where it conflicted with the brief or with how CDS works.

## Onboarding: customs profile wizard

### 1. Capture business identity

- "What is your company's EORI number?" Input accepts `GB` or `XI` followed by 12 digits.
- Helper: "Don't have one? Apply on GOV.UK. You need this to import goods into the UK."
- Backend: strip whitespace, upper-case, validate `^(GB|XI)\d{12}$`, save to
  `Organization.eoriNumber` (encrypted at rest, §7.3), audit `org.eori.update`. HMRC EORI check
  runs as an async job (§5.6).

### 1b. Company lookup (ADR-0015)

- "Is your business a limited company?" The platform looks up the organisation name at
  Companies House and shows the best match: "Is this you? Hydro Imports Ltd, 12345678, active."
  The user confirms or picks another match, or says "I'm a sole trader or partnership".
- Backend: stores the company number, status, type and check time. Only active limited
  companies and LLPs will later see the trade finance module; nothing else changes for others.

### 2. VAT cash flow

- "Are you VAT registered in the UK?" Yes / No.
- If Yes: "What is your VAT Registration Number (VRN)?" Validated `^GB\d{9}(\d{3})?$` with the
  check digit, verified against HMRC asynchronously; a mismatch warns, it does not block.
- If Yes: "How do you want to handle import VAT?"
  - A: "Account for it on my VAT return (postponed VAT accounting). Better for cash flow."
  - B: "Pay it at the border."
- Backend: A sets `CustomsProfile.usePva = true`. The database refuses this without a VAT
  registration.
- **Corrected:** PVA changes when VAT is paid, not what the goods cost. The quote still shows
  import VAT; it moves out of "Cash needed at the border" (`borderOutlay`) with the note
  "Import VAT £X is accounted for on your VAT return." The first-draft line "keeping landed-cost
  estimates strictly to freight and duty" is wrong and must not ship.
- **Corrected:** the step is shown to everyone. Its first question decides whether the rest
  appears (the draft subtitle said "only shown if the user provides a VAT number").

### 3. Duty payment routing

- "When your goods arrive, how do you want to pay UK customs duty?"
  1. Default: "Through our forwarding partner." Helper: "Our partner forwarder pays HMRC from
     its deferment account to release your goods and invoices you. They charge an advancement
     fee of {fee terms}."
  2. "I have my own HMRC duty deferment account (DAN)."
  3. "I have a pre-funded HMRC cash account."
- Backend: maps to `PaymentMethod` (`BROKER_DEFERMENT`, `OWN_DEFERMENT`, `CDS_CASH_ACCOUNT`).
  With option 1 the quote engine receives `brokerDeferment` from the forwarder's configured
  terms (`CustomsProfile.brokerDefermentFeePct`, `brokerDefermentMinimumGbp`).
- **Corrected:** "Let the platform handle it. We pay HMRC on your behalf" breaks the brief's
  rule that we never act as customs principal and never hold client money. The forwarder pays;
  the copy must say so.
- **Corrected:** "a standard 2.5% fee" is not a standard. The fee comes from the signed
  forwarder's terms and is shown with its minimum (decision (l)).

### 4. Authorise the forwarder (only for own deferment account)

- "Before your goods can be cleared using your deferment account, HMRC requires you to authorise
  our forwarding partner to use it."
  1. Sign in to the Customs Declaration Service financial dashboard with your Government
     Gateway ID.
  2. Open "Manage account authorities".
  3. Add our forwarding partner's EORI: `{FORWARDER_EORI}`.
- Checkbox: "I confirm I have authorised {forwarder name}'s EORI in my CDS account."
- Backend: sets `cdsAuthorityGranted = true` with `cdsAuthorityConfirmedAt` and the confirming
  user (the database requires the timestamp), audit `org.cds_authority.confirm`.
- **Corrected:** the EORI to authorise is the forwarder's, because the forwarder is the customs
  agent (§7.7). The platform has no customs EORI to give. The example `GB987654321000` is a
  placeholder and must come from configuration once the forwarder agreement is signed.
- **Corrected:** this gates booking (Phase 2), not quoting. Quotes stay available.

## Navigation

Home · Quotes · Products · Documents · Settings & billing. No "consignments" or "customs
entries" jargon.

## Home

- **Action required banner.** Shown when `eoriNumber` is missing, or when
  `paymentMethod = OWN_DEFERMENT` and `cdsAuthorityGranted` is false. **Corrected:** it blocks
  booking, not quotes; quotes without an EORI are still useful for supplier comparison.
- **Jump back in.** The three most recently edited draft quotes.
- **Quick duty check.** HS code plus invoice value gives duty and VAT rates without saving a
  quote. It reuses the tariff client, the 24-hour cache and the tariff rate limit (10/min).

## Products (catalogue)

Every saved product pre-fills the customs and freight inputs of future quotes. It looks like an
inventory list; it is really the reusable compliance data behind every quote.

### List

A dense table: SKU, product name, supplier, origin, HS code, unit value and currency, CBM and
weight per unit, and a verified mark when `hsCodeVerifiedAt` is set. Unverified codes show an
amber mark, because they make every quote using them `INDICATIVE` (§5.2).

### Add or edit product

A right-hand drawer, not a wizard, in three sections mapped to the Prisma `Product` model:

- **Identity:** SKU (unique per organisation), name, supplier (picked from `Supplier`, or created
  inline with name and country).
- **Sourcing:** origin country (searchable ISO list; stored on the product because it can differ
  from the supplier's country and it drives preferential rates), unit value and currency.
- **Logistics and compliance:** unit weight (kg), unit volume (CBM) or carton dimensions plus
  units per carton (volume computed with Decimal), and the HS code.

### HS code field

- Strip spaces and dots as the user types.
- **Corrected:** accept 6, 8 or 10 digits, not only 10. A 10-digit code is looked up directly.
  A 6- or 8-digit code lists its 10-digit children with their official descriptions and duty
  rates, and the user picks one; the system never guesses (§5.2, ADR-0006). Anything else (for
  example 9 or 11 digits) is rejected with a clear message.
- On a complete code, a debounced server call shows the official description below the field,
  such as "Tableware and kitchenware, of plastics". It uses the existing tariff client with its
  24-hour cache and the tariff rate limit (10 lookups per minute per user, §7.5).
- `hsCodeVerifiedAt` is set only when the lookup succeeds. If the tariff service is down the
  product can still be saved, unverified, with a message saying so.
- **Corrected:** the API is the UK Trade Tariff service at
  `https://www.trade-tariff.service.gov.uk/api/v2`, which the adapters already use, not
  `api.trade.gov.uk`.

### Adding catalogue products to a quote

"Add from catalogue", pick a product, type a quantity. The engine multiplies weight and volume,
converts the value at the HMRC monthly rate, and applies the product's tariff. On save, each
line **copies** the product's HS code, origin, value, currency, weight and volume into
`QuoteLine` (quotes are snapshots, §1): editing the product later never changes an existing
quote. The builder offers "update to current catalogue values" on draft quotes only.

### Data notes

- **Corrected:** the example "Kyoto Ceramics, JP, ¥1200" needs JPY, which is not in the
  current currency allow-list (GBP, USD, EUR, CNY, INR, TRY, VND, BDT, PKR, §5.6). HMRC publishes
  a monthly JPY rate, so adding it is a one-line change plus a test. Japanese origin can also
  qualify for the UK–Japan agreement preference, which the engine handles when the user claims
  it.
- The sample HS codes in the draft have not been checked against the tariff. Verify them with
  the lookup before using them in demos or fixtures.

## Quote builder

- Split screen: inputs left, a sticky breakdown right that recalculates as the user types
  (debounced server call to the engine; the engine never runs in the browser).
- Inputs: supplier and origin, incoterm with plain-English labels ("FOB: supplier pays to the
  port", "EXW: I pay from the factory door"), product lines picked from the catalogue (HS code,
  weight, unit value pre-filled and snapshotted into the quote on save).
- Breakdown: goods; freight and fees (with rate source and expiry); UK duty; import VAT; cash
  needed at the border (`borderOutlay`); total landed cost; **landed cost per unit, ex VAT for
  VAT-registered users**, which is the Shopify pricing figure. Status banner and warnings as in
  the Phase 0 calculator.

## Documents

- **Missing files** list per accepted quote or shipment, e.g. "Quote #1042: awaiting commercial
  invoice", with an upload button.
- **Organisation documents** for records that apply to every shipment: EORI confirmation, VAT
  certificate, the signed direct-representation authority for the forwarder.
- **Upload** asks for the document type (`DocumentType`) before the presigned upload, then shows
  scanning status (§7.4).

## Settings and billing

- Customs profile: the wizard above, editable, with audit entries. Only OWNER and ADMIN can edit
  EORI and VAT (§7.2).
- Billing (OWNER only): "Manage subscription" creates a Stripe Billing Portal session server-side
  and redirects. Price and plan names come from Stripe, not code.
