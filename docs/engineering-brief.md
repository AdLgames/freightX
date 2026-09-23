<!-- Verbatim copy of the engineering brief (v0.1). Do not edit here; changes to the spec go through an ADR. -->
# Engineering Brief: Landed-Cost & Import Workspace (Working Name: Harbour)

**Audience:** dev team, kickoff
**Status:** v0.1 — build plan for Phase 0 and Phase 1, design for Phase 2
**Owner:** founder / product

---

## 1. What we are building and why

A subscription workspace for UK micro-importers (1–20 staff) that:

1. Quotes the **fully landed cost per unit** of an import before the customer commits to a supplier (freight + duty + VAT + fees).
2. Stores their products, HS codes, suppliers and documents so every future quote takes seconds.
3. Later, books the freight through a partner forwarder via API and tracks the shipment to the door.

We make money from the subscription and embedded services (insurance, duty payment, FX). Booking margin is secondary. **We are never the freight forwarder, never the customs principal, and never hold client money.** Every design decision below protects those three lines.

### Non-negotiable principles

| Principle | What it means in code |
|---|---|
| **We are a calculator and a system of record, not a carrier** | Nothing we return is a contractual rate. Every quote carries `validUntil`, `rateSource` and a disclaimer flag. The booking step hands the contract to the forwarder. |
| **Quotes are immutable snapshots** | Once `ACCEPTED`, a quote never changes. Product prices, FX rates and tariff measures are copied into the quote, not referenced. |
| **Tenant isolation is absolute** | Every query is scoped by `organizationId`. No exceptions, no "admin shortcuts" in app code. |
| **Fail closed on money and customs** | If any external input (tariff, FX, freight) is missing, stale or ambiguous, the quote is marked `INDICATIVE` and booking is blocked. We never silently default a duty rate to 0%. |
| **Assume every external API will be down, slow or wrong** | Cache, retry, circuit-break, and degrade to a labelled fallback. |

---

## 2. Phasing

| Phase | Deliverable | Gate to move on |
|---|---|---|
| **0 — Calculator** | Public landed-cost calculator, no login, no persistence beyond analytics | 200 completed calculations, 50 email signups |
| **1 — Workspace** | Auth, orgs, products, saved quotes, document vault, Stripe subscription | 20 paying orgs |
| **2 — Booking & tracking** | Forwarder API booking, payments via forwarder invoicing or Stripe Connect, shipment timeline | Signed forwarder agreement + sandbox access |

Phase 2 is designed now so the schema doesn't need a migration, but **no Phase 2 code ships until the forwarder partnership is signed.**

---

## 3. Stack

- **Framework:** Remix (React Router v7 mode), TypeScript strict, Node 22 LTS
- **DB:** Postgres 16 via Prisma. Row-level security enabled as a second line of defence (see §7.2)
- **Queue / jobs:** BullMQ on Redis (tariff refresh, FX refresh, forwarder polling, webhook processing)
- **Storage:** S3-compatible bucket (Cloudflare R2 or AWS S3), private, presigned URLs only
- **Auth:** Remix sessions (httpOnly, secure, SameSite=Lax), email magic link + optional passkey. No password storage in v1.
- **Payments:** Stripe Billing for subscriptions. Booking payments: **forwarder invoices customer directly** in Phase 2 v1 (see §6.3).
- **Validation:** zod at every boundary (form data, loaders, API responses, webhooks)
- **Observability:** OpenTelemetry → Grafana/Tempo or Datadog; Sentry for errors; structured JSON logs with request IDs
- **Infra:** Fly.io or Railway for app, managed Postgres, managed Redis. Terraform or Pulumi from day one.
- **Money:** every monetary value is `Decimal` in Prisma and `decimal.js` in code. **Never `number` for money.**

---

## 4. Data model

Changes from the draft schema are marked **(NEW)** or **(CHANGED)**. Full file at `prisma/schema.prisma`.

```prisma
// ---------- Tenancy & identity ----------

model Organization {
  id            String   @id @default(uuid())
  name          String
  eoriNumber    String?  // encrypted at rest, validated on save (§5.6)
  vatNumber     String?  // encrypted at rest, validated against HMRC VAT API (§5.6)
  vatRegistered Boolean  @default(false)
  baseCurrency  String   @default("GBP")
  plan          Plan     @default(FREE)
  stripeCustomerId String? @unique
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime? // soft delete (NEW)

  members       Membership[]
  products      Product[]
  suppliers     Supplier[]
  quotes        Quote[]
  shipments     Shipment[]
  auditLogs     AuditLog[]
}

model User {                                   // (NEW)
  id          String   @id @default(uuid())
  email       String   @unique
  name        String?
  mfaEnabled  Boolean  @default(false)
  createdAt   DateTime @default(now())
  memberships Membership[]
}

model Membership {                             // (NEW)
  id             String   @id @default(uuid())
  userId         String
  organizationId String
  role           Role     @default(MEMBER)
  user           User         @relation(fields: [userId], references: [id])
  organization   Organization @relation(fields: [organizationId], references: [id])
  @@unique([userId, organizationId])
}

enum Role   { OWNER ADMIN MEMBER VIEWER }
enum Plan   { FREE STARTER PRO }

// ---------- Catalogue ----------

model Supplier {                               // (NEW)
  id             String   @id @default(uuid())
  organizationId String
  name           String
  countryCode    String   // ISO 3166-1 alpha-2 — drives preferential origin
  defaultIncoterm Incoterm?
  organization   Organization @relation(fields: [organizationId], references: [id])
  products       Product[]
}

model Product {
  id             String   @id @default(uuid())
  organizationId String
  supplierId     String?
  sku            String
  name           String
  hsCode         String   // 8 or 10 digits, validated against tariff (§5.2)
  hsCodeVerifiedAt DateTime?            // (NEW) null = user-entered, unverified
  originCountry  String   // (NEW) ISO code; may differ from supplier country
  unitValue      Decimal  @db.Decimal(14, 4)
  currency       String   // (NEW) ISO 4217
  weightKg       Decimal  @db.Decimal(10, 3)
  volumeCbm      Decimal  @db.Decimal(10, 4)
  unitsPerCarton Int?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  organization   Organization @relation(fields: [organizationId], references: [id])
  supplier       Supplier?    @relation(fields: [supplierId], references: [id])
  quoteLines     QuoteLine[]
  @@unique([organizationId, sku])
  @@index([organizationId])
}

// ---------- Quoting ----------

enum QuoteStatus { DRAFT INDICATIVE READY ACCEPTED EXPIRED CANCELLED }
enum Incoterm    { EXW FCA FOB CFR CIF DAP DPU DDP }
enum Mode        { SEA_LCL SEA_FCL AIR ROAD RAIL }

model Quote {
  id               String      @id @default(uuid())
  organizationId   String
  status           QuoteStatus @default(DRAFT)
  incoterm         Incoterm
  mode             Mode
  originCountry    String
  originPort       String?     // UN/LOCODE
  destinationPort  String?     // UN/LOCODE
  deliveryPostcode String?

  // Snapshotted inputs (CHANGED — nothing here is a live reference)
  fxRate           Decimal     @db.Decimal(14, 6)   // supplier ccy → GBP
  fxSource         String      // "HMRC_MONTHLY" | "ECB" | "MANUAL"
  fxDate           DateTime
  rateSource       String      // "SEARATES" | "RATE_SHEET_V3" | "MANUAL"
  rateFetchedAt    DateTime
  validUntil       DateTime    // freight rate expiry

  // Aggregates in GBP, computed from lines
  goodsValueGbp    Decimal @db.Decimal(14, 2)
  freightCost      Decimal @db.Decimal(14, 2)
  originFees       Decimal @db.Decimal(14, 2)
  destinationFees  Decimal @db.Decimal(14, 2)
  insurancePremium Decimal @db.Decimal(14, 2) @default(0)
  customsValue     Decimal @db.Decimal(14, 2)   // (CHANGED) not "CIF" — see §5.3
  totalDuty        Decimal @db.Decimal(14, 2)
  totalVat         Decimal @db.Decimal(14, 2)
  vatRecoverable   Boolean                      // (NEW) postponed VAT accounting
  platformFee      Decimal @db.Decimal(14, 2)
  totalLandedCost  Decimal @db.Decimal(14, 2)   // incl. VAT
  totalLandedCostExVat Decimal @db.Decimal(14, 2) // (NEW) the number VAT-registered users care about

  warnings         Json     // (NEW) array of {code, message} e.g. ADD_APPLIES, HS_UNVERIFIED
  calcVersion      String   // (NEW) engine version that produced this quote
  acceptedAt       DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  organization     Organization @relation(fields: [organizationId], references: [id])
  lines            QuoteLine[]
  shipment         Shipment?
  @@index([organizationId, status])
}

model QuoteLine {                              // (NEW) — the missing piece
  id               String  @id @default(uuid())
  quoteId          String
  productId        String
  quantity         Int
  // Snapshots
  hsCode           String
  originCountry    String
  unitValue        Decimal @db.Decimal(14, 4)
  currency         String
  unitValueGbp     Decimal @db.Decimal(14, 4)
  lineGoodsValueGbp Decimal @db.Decimal(14, 2)
  lineWeightKg     Decimal @db.Decimal(10, 3)
  lineVolumeCbm    Decimal @db.Decimal(10, 4)
  // Tariff result
  tariffMeasureId  String? // HMRC measure SID we applied
  dutyType         String  // "AD_VALOREM" | "SPECIFIC" | "COMPOUND" | "NONE"
  dutyRatePct      Decimal? @db.Decimal(7, 4)
  dutySpecific     Json?   // {amount, unit, per} for £/kg etc.
  preferenceClaimed Boolean @default(false)
  addRatePct       Decimal? @db.Decimal(7, 4) // anti-dumping, if any
  vatRatePct       Decimal @db.Decimal(5, 2)  // 20 / 5 / 0
  // Allocations (freight apportioned by weight/volume — §5.4)
  allocatedFreightGbp Decimal @db.Decimal(14, 2)
  lineCustomsValueGbp Decimal @db.Decimal(14, 2)
  lineDutyGbp      Decimal @db.Decimal(14, 2)
  lineVatGbp       Decimal @db.Decimal(14, 2)
  landedCostPerUnit Decimal @db.Decimal(14, 4)

  quote            Quote   @relation(fields: [quoteId], references: [id], onDelete: Cascade)
  product          Product @relation(fields: [productId], references: [id])
  @@index([quoteId])
}

// ---------- Execution (Phase 2) ----------

enum ShipmentStatus { PENDING_DOCS PENDING_BOOKING BOOKED DISPATCHED IN_TRANSIT AT_DESTINATION CUSTOMS CLEARED OUT_FOR_DELIVERY DELIVERED EXCEPTION CANCELLED }

model Shipment {
  id             String  @id @default(uuid())
  organizationId String  // (NEW) denormalised for RLS
  quoteId        String  @unique
  status         ShipmentStatus @default(PENDING_DOCS)
  forwarderId    String?          // (NEW) which partner
  forwarderRef   String?
  containerNo    String?
  vesselOrFlight String?
  etd            DateTime?
  eta            DateTime?
  atd            DateTime?
  ata            DateTime?
  bookingIdempotencyKey String? @unique // (NEW) §6.2
  lastPolledAt   DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization   Organization @relation(fields: [organizationId], references: [id])
  quote          Quote        @relation(fields: [quoteId], references: [id])
  documents      Document[]
  events         ShipmentEvent[]
  @@index([organizationId, status])
}

model ShipmentEvent {                          // (NEW) — append-only timeline
  id              String   @id @default(uuid())
  shipmentId      String
  source          String   // "FORWARDER_WEBHOOK" | "POLL" | "MANUAL" | "SYSTEM"
  providerEventId String?  // idempotency — unique per source
  eventType       String   // vessel_departed, customs_cleared...
  statusAfter     ShipmentStatus?
  occurredAt      DateTime
  receivedAt      DateTime @default(now())
  payload         Json     // raw, redacted of PII
  shipment        Shipment @relation(fields: [shipmentId], references: [id], onDelete: Cascade)
  @@unique([source, providerEventId])
  @@index([shipmentId, occurredAt])
}

enum DocumentType { COMMERCIAL_INVOICE PACKING_LIST BILL_OF_LADING AIRWAY_BILL CERTIFICATE_OF_ORIGIN INSURANCE_CERT OTHER }
enum DocumentStatus { UPLOADED SCANNING CLEAN REJECTED VERIFIED }

model Document {
  id             String   @id @default(uuid())
  organizationId String   // (NEW)
  shipmentId     String?
  type           DocumentType
  status         DocumentStatus @default(UPLOADED)
  storageKey     String   // never a public URL (CHANGED)
  originalName   String
  mimeType       String
  sizeBytes      Int
  sha256         String
  version        Int      @default(1)
  uploadedById   String
  verifiedById   String?
  verifiedAt     DateTime?
  createdAt      DateTime @default(now())
  shipment       Shipment? @relation(fields: [shipmentId], references: [id])
  @@index([organizationId])
}

// ---------- Cross-cutting ----------

model AuditLog {                               // (NEW)
  id             String   @id @default(uuid())
  organizationId String?
  userId         String?
  action         String   // "quote.accept", "org.eori.update", "doc.download"
  targetType     String
  targetId       String
  ip             String?
  userAgent      String?
  metadata       Json?
  createdAt      DateTime @default(now())
  @@index([organizationId, createdAt])
}

model TariffCache {                            // (NEW)
  hsCode       String
  originCountry String
  fetchedAt    DateTime
  expiresAt    DateTime
  payload      Json
  @@id([hsCode, originCountry])
}

model FxRate {                                 // (NEW)
  id        String   @id @default(uuid())
  source    String
  currency  String
  rateToGbp Decimal  @db.Decimal(14, 6)
  validFrom DateTime
  validTo   DateTime
  @@unique([source, currency, validFrom])
}
```

### Migration rules
- Every migration reviewed by two people. No `prisma db push` outside local.
- Destructive migrations require a backup snapshot ID in the PR description.
- Enums are additive only; never rename a value in place.

---

## 5. Phase 0/1 — Landed-cost engine

The engine is a pure TypeScript module (`packages/engine`) with **no I/O**. It takes resolved inputs and returns a `QuoteResult`. All fetching happens in adapters. This is what lets us test it exhaustively.

### 5.1 Pipeline

```
resolveProducts → resolveFx → resolveFreight → resolveTariff → compute → validate → persist
```

Each stage returns `{ ok, value, warnings[] }`. A hard failure at any stage produces a quote in `INDICATIVE` status with the failure recorded in `warnings`, never a thrown 500 to the user.

### 5.2 HS code handling

- Accept 6, 8 or 10 digits. Normalise to 10 by looking up the UK tariff; if the 6-digit heading maps to multiple 10-digit codes with different duties, **stop and ask the user to pick**. Never guess.
- Validate via the **UK Trade Tariff API** (`https://www.trade-tariff.service.gov.uk/api/v2/commodities/{code}`). Cache 24h in `TariffCache`.
- Set `hsCodeVerifiedAt` only on a successful lookup. Unverified codes produce warning `HS_UNVERIFIED` and block `READY` status.
- Parse tariff **measures**, not a single "duty rate":
  - `103` third-country duty (default)
  - `142` preferential duty (only if `originCountry` matches the agreement and user has ticked `preferenceClaimed`)
  - `552`/`554` anti-dumping / countervailing → add to `addRatePct`, emit `ADD_APPLIES`
  - `305` VAT rate
  - `122`/`123` quotas → emit `QUOTA_APPLIES` (we do not model quota balances in v1)
- Duty expressions may be ad valorem (`%`), specific (`£ per 100 kg`), or compound. The engine must handle all three; specific duties require `lineWeightKg` and a unit conversion table.
- **Failsafe:** if measure parsing yields no recognisable duty measure, emit `TARIFF_AMBIGUOUS` and mark `INDICATIVE`. Do **not** default to 0%.

### 5.3 Customs value (not "CIF")

UK customs value for duty is broadly: goods value + freight and insurance **to the UK border** + certain origin charges. Post-border costs (UK haulage, destination handling) are excluded from duty but **included in the VAT base**.

```
customsValue  = goodsValueGbp + originFees + freightToBorder + insurancePremium   (adjusted by incoterm, §5.5)
dutyBase      = customsValue
vatBase       = customsValue + totalDuty + destinationFees (post-border)
```

`freightToBorder` vs post-border split: for sea, use the freight quote's port-to-port leg as "to border" and UK haulage as post-border. If the rate source doesn't split it, apportion 100% to-border and emit `FREIGHT_SPLIT_ASSUMED`.

### 5.4 Apportioning shared costs across lines

Freight, origin and destination fees are shipment-level. Allocate to lines by **chargeable weight share** (sea: CBM vs tonnes, whichever is greater; air: greater of actual kg and volumetric at 1:6000). Store the basis on the quote. Sum of allocations must equal the total to the penny — allocate the rounding remainder to the largest line and assert in a test.

### 5.5 Incoterm branching

| Incoterm | Freight included in supplier price? | Engine action |
|---|---|---|
| EXW | No | add origin fees + freight + destination |
| FCA / FOB | No (origin charges usually included) | add freight + destination; origin fees only if user says otherwise |
| CFR / CIF | Yes (to port) | do **not** add freight; still add destination fees; CIF: do not add insurance |
| DAP / DPU | Yes (to door) | freight = 0 in our calc; customs value still needs a freight element → require user to enter supplier's freight portion or emit `INCOTERM_FREIGHT_UNKNOWN` |
| DDP | Yes incl. duty | show duty/VAT as supplier's cost, not the user's; flag that DDP into UK rarely works cleanly for micro-importers |

### 5.6 Input validation (zod schemas in `app/validators`)

- `eoriNumber`: `^GB\d{12}$` or `^XI\d{12}$`; check-digit validation where possible; verify via HMRC EORI checker API on save (async job, result stored).
- `vatNumber`: `^GB\d{9}(\d{3})?$`; verify via HMRC VAT API; mismatch produces warning, not block.
- `hsCode`: digits only, 6/8/10 length.
- `unitValue`, `weightKg`, `volumeCbm`: positive Decimal, max 4 dp, upper sanity bounds (weight < 30,000 kg per line, CBM < 100). Out-of-range → warning `SANITY_BOUND`.
- `quantity`: positive int ≤ 1,000,000.
- `currency`: ISO 4217 allow-list (GBP, USD, EUR, CNY, INR, TRY, VND, BDT, PKR initially).
- Postcodes: UK format regex; port codes: UN/LOCODE allow-list.
- All strings trimmed, max lengths enforced, no HTML.

### 5.7 FX

- Primary: **HMRC monthly exchange rates** (published ~1 week before the month). Job fetches on the 25th and on the 1st; alert if missing by the 2nd.
- Fallback: ECB daily reference rate, flagged `fxSource = "ECB"` with warning `FX_FALLBACK`.
- User can override with a manual rate; quote records `fxSource = "MANUAL"` and shows it.
- **Never** call a live FX API inside the request path.

### 5.8 Freight rates

- Phase 0: our own **rate sheet** (versioned JSON in repo, `rateSource = "RATE_SHEET_Vn"`) covering the top 10 lanes (Shanghai/Ningbo/Shenzhen/Mumbai/Istanbul → Felixstowe/Southampton/London Gateway; air to LHR). Refreshed fortnightly from the Freightos Baltic Index and forwarder quotes.
- Phase 1: SeaRates API behind an adapter with:
  - 5s timeout, 2 retries with jitter
  - circuit breaker (opossum): open after 5 failures / 60s, half-open probe every 30s
  - on open circuit → fall back to rate sheet, warning `FREIGHT_FALLBACK`
  - response cached 6h keyed on (origin, destination, mode, weight band, CBM band)
- Rate validity: `validUntil` = min(provider expiry, fetchedAt + 7 days). Cron expires quotes hourly.
- **Sanity check:** if the returned rate is < 20% or > 500% of the rate-sheet figure for the same lane, emit `RATE_OUTLIER` and require human review before `READY`.

### 5.9 Status rules

- `DRAFT`: being edited.
- `INDICATIVE`: computed but has a blocking warning (HS unverified, tariff ambiguous, fallback rate, outlier). Displayed with a banner; cannot be accepted.
- `READY`: all inputs verified, no blocking warnings.
- `ACCEPTED`: user clicked accept; row becomes immutable (enforced by a Postgres trigger that rejects UPDATE on accepted quotes except `status` → `CANCELLED`/`EXPIRED`).
- `EXPIRED`: past `validUntil`.

Blocking warnings: `HS_UNVERIFIED`, `TARIFF_AMBIGUOUS`, `RATE_OUTLIER`, `INCOTERM_FREIGHT_UNKNOWN`. Non-blocking: everything else.

### 5.10 Testing the engine

- **Golden tests**: a `fixtures/quotes/*.json` set of ≥30 real-world scenarios with expected outputs, reviewed by someone who has done customs entries. Includes: 0% preferential, ADD case, specific duty (e.g. sugar-based), compound duty, 5% VAT goods, multi-line apportionment, each incoterm.
- Property tests (fast-check): totals equal sum of lines; landed cost monotonic in quantity; no negative values.
- Contract tests against recorded tariff API responses (nock/msw). Re-record monthly.
- Engine version bump (`calcVersion`) on any formula change; old quotes keep their version.

---

## 6. Phase 2 — Booking & tracking (design only, do not build yet)

### 6.1 Preconditions to book (all enforced server-side in a single transaction)

1. Quote `ACCEPTED` and not expired.
2. Org has verified `eoriNumber`.
3. `COMMERCIAL_INVOICE` and `PACKING_LIST` documents exist with status `CLEAN` or `VERIFIED`.
4. User role ≥ `ADMIN`.
5. Org subscription active.
6. Denied-party screen passed (§7.7).
7. Feature flag `booking.enabled` on for this org (kill switch).

### 6.2 Booking call

- Idempotency key = `sha256(quoteId + forwarderId)`, stored on `Shipment.bookingIdempotencyKey`, sent as `Idempotency-Key` header. Retry-safe.
- Outbox pattern: write `Shipment` in `PENDING_BOOKING` and an outbox row in the same transaction; a worker makes the external call. If the app dies mid-flight we never lose or double-book.
- Documents are shared with the forwarder via **presigned GET URLs with 15-minute expiry**, generated at send time. Never store a presigned URL.
- On success: store `forwarderRef`, status `BOOKED`, audit log `shipment.booked`.
- On failure after retries: status `EXCEPTION`, alert ops, user sees "we're checking with the forwarder", **not** a stack trace.

### 6.3 Payments (decision needed — see §10)

**Recommended v1:** the forwarder invoices the customer directly; we invoice our platform fee via Stripe. We never touch freight money, no client-money rules apply.

**Later option:** Stripe Connect (Express) with the forwarder as connected account, Bacs Direct Debit to keep fees low, application fee for our margin. Requires forwarder onboarding to Stripe.

**Not doing:** collecting freight funds into our account and paying the forwarder out. That is holding client money and needs FCA authorisation or a licensed partner.

### 6.4 Webhooks & polling

- Endpoint `/webhooks/forwarder/:forwarderId`, POST only.
- Verify HMAC signature with per-forwarder secret; reject with 401 on mismatch; constant-time compare.
- Reject payloads > 256 KB; reject timestamps older than 5 minutes (replay).
- Enqueue immediately, return 200 within 2s. All processing in the worker.
- Worker upserts `ShipmentEvent` on `(source, providerEventId)`; duplicates are no-ops.
- State machine for `ShipmentStatus`: transitions defined in one table; illegal transitions log a warning and are stored as events but do not change status.
- Polling fallback: every 6h for `BOOKED..CUSTOMS` shipments if no webhook in 24h; stops at `DELIVERED`/`CANCELLED`.
- Dead-letter queue for events that fail 5 times; ops dashboard shows DLQ depth.

---

## 7. Security

### 7.1 Authentication
- Magic link (15-min single-use token, hashed in DB) + WebAuthn passkeys. Rate-limit link requests: 5/hour/email, 20/hour/IP.
- Sessions: server-side session store in Redis, 30-day sliding expiry, rotated on privilege change, invalidated on email change.
- Optional TOTP MFA; **required** for `OWNER`/`ADMIN` before Phase 2 booking is enabled for the org.
- Cookies: `HttpOnly; Secure; SameSite=Lax; Path=/`. CSRF token on every mutating form (Remix `csrf` util).

### 7.2 Authorisation & tenancy
- Every loader/action resolves `currentOrg` from session + membership, **never** from a URL param alone.
- A Prisma client extension injects `where: { organizationId }` on all tenant models; models not in the allow-list cannot be queried without an explicit `orgId`.
- Postgres **row-level security** on all tenant tables, using `SET LOCAL app.current_org` per transaction. This catches any bug that bypasses the Prisma layer.
- RBAC matrix (checked in a single `can(user, action, resource)` helper, unit-tested):

| Action | OWNER | ADMIN | MEMBER | VIEWER |
|---|---|---|---|---|
| view quotes | ✓ | ✓ | ✓ | ✓ |
| create/edit quotes | ✓ | ✓ | ✓ | |
| accept quote | ✓ | ✓ | | |
| upload docs | ✓ | ✓ | ✓ | |
| download docs | ✓ | ✓ | ✓ | ✓ |
| edit EORI/VAT | ✓ | ✓ | | |
| book shipment | ✓ | ✓ | | |
| billing | ✓ | | | |
| manage members | ✓ | ✓ | | |

- Admin/support access to customer data goes through a separate internal app with its own audit trail and just-in-time approval. No "god mode" in the customer app.

### 7.3 Data protection
- `eoriNumber`, `vatNumber`, document contents: encrypted at rest with envelope encryption (KMS-managed key, per-org data key). Field-level encryption via Prisma extension.
- TLS 1.2+ only, HSTS preload, no mixed content.
- PII minimisation: we do not store supplier bank details, passport scans or anything not needed for a quote.
- Logs: redact emails, EORI, VAT, document names. Log IDs only.
- GDPR: data export endpoint (JSON + documents zip) and deletion job (soft delete → hard delete after 30 days, documents purged from storage, audit logs retained 6 years as legitimate interest — confirm with counsel).
- Backups: daily encrypted snapshots, 30-day retention, quarterly restore drill.

### 7.4 File uploads
- Client uploads directly to storage via **presigned PUT**, 25 MB limit, allowed types: PDF, PNG, JPG, XLSX, CSV. Content-type enforced on the presign, not trusted from the client.
- On upload-complete webhook: compute sha256, run ClamAV (or Cloudflare/AWS malware scan), sniff magic bytes to confirm type matches extension. Status `SCANNING` → `CLEAN`/`REJECTED`.
- Documents are served only via presigned GET (5-min expiry) after an authorisation check. Bucket is private; no public ACLs; block-public-access enforced in Terraform.
- Filenames sanitised; stored under `orgId/shipmentId/docId` keys, never the original name.

### 7.5 Input & output hygiene
- zod on every boundary including third-party API responses (a malformed tariff response must not crash or mis-price).
- Parameterised queries only (Prisma). No raw SQL without review.
- Output encoding by React; no `dangerouslySetInnerHTML`.
- CSP: `default-src 'self'`; script nonce; `frame-ancestors 'none'`; report-uri.
- Rate limiting (Redis token bucket): 60 req/min per user on quote endpoints, 10/min on tariff lookups, 300/min per IP globally. Public calculator: 20 calcs/hour/IP + Turnstile.

### 7.6 Secrets & supply chain
- Secrets in the platform's secret manager; never in env files committed to git; `gitleaks` in pre-commit and CI.
- Separate credentials per environment; forwarder/SeaRates keys are sandbox-only outside prod.
- Dependabot/Renovate weekly; `npm audit` fails CI on high/critical; lockfile committed; `--ignore-scripts` on install in CI.
- Docker images pinned by digest; distroless runtime; non-root user.
- Branch protection: PR + 1 review + green CI; signed commits encouraged.

### 7.7 Compliance screening (Phase 2)
- Before booking, screen consignee and supplier names against the UK Sanctions List (OFSI) and, via the forwarder if offered, denied-party lists. Store screening result + timestamp on the shipment.
- Block HS chapters we will not touch in v1: 93 (arms), 28/29 hazardous where dangerous-goods class applies, live animals, excise goods (22, 24). Emit `RESTRICTED_GOODS` and route to manual review.
- Terms of service make the customer responsible for export controls and accuracy of declarations; the forwarder is customs agent. Get this reviewed by a trade solicitor before Phase 2.

### 7.8 Monitoring & incident response
- Sentry with PII scrubbing. PagerDuty/OpsGenie rota once we have paying customers.
- Alerts: error rate > 1% / 5 min; p95 latency > 2s; tariff or FX job failed; circuit breaker open > 10 min; DLQ depth > 0; failed login spike; presigned URL generation spike.
- Incident runbook in `/docs/runbooks`. Security incident: revoke sessions, rotate secrets, notify affected orgs within 72h (GDPR).

---

## 8. Failsafes summary

| Risk | Control |
|---|---|
| Wrong duty rate silently applied | No default rates; ambiguous tariff → `INDICATIVE`; golden tests; `calcVersion` on every quote |
| Stale freight price used | `validUntil` + hourly expiry job; outlier detection vs rate sheet |
| External API outage | Timeouts, retries, circuit breaker, labelled fallback, never in-request FX calls |
| Double booking | Idempotency key + outbox pattern + unique constraint |
| Lost webhook | Idempotent upsert + polling fallback + DLQ |
| Cross-tenant data leak | Prisma extension + Postgres RLS + RBAC helper + tests that attempt cross-org reads |
| Malicious upload | Presigned PUT with type enforcement, AV scan, magic-byte check, private bucket |
| Money precision errors | Decimal everywhere, rounding remainder test, no `number` for currency (lint rule) |
| Accidental mutation of accepted quote | DB trigger rejects updates |
| Runaway costs on public calculator | Per-IP limits, Turnstile, cache |
| Shipping something we shouldn't | Restricted HS chapters, sanctions screen, forwarder as customs agent, booking kill switch |

---

## 9. Definition of done (per PR)

- [ ] zod schema for every new input/output
- [ ] `organizationId` scoping present and covered by a cross-tenant negative test
- [ ] Money as `Decimal`; lint passes
- [ ] Unit tests for engine changes + golden fixtures updated; `calcVersion` bumped if formula changed
- [ ] Audit log entry for any state-changing action on quotes, docs, org settings
- [ ] No secrets, no PII in logs (checked via log snapshot test)
- [ ] Migration reviewed; rollback noted
- [ ] Feature flag for anything user-visible in Phase 2

---

## 10. Decisions needed before sprint 1

1. **Rate source for Phase 1:** SeaRates self-serve vs. building the rate sheet only until a forwarder deal exists. *Recommendation: rate sheet for Phase 0, SeaRates in Phase 1.*
2. **Payments model for Phase 2:** forwarder-invoices-direct (recommended) vs. Stripe Connect.
3. **Hosting region:** UK/EU only (recommended for GDPR simplicity).
4. **Who reviews the golden fixtures:** we need a customs practitioner for ~2 days.
5. **Insurance partner** for the embedded cargo-insurance add-on (Phase 1.5).

---

## 11. Sprint 1 scope (2 weeks)

1. Repo, CI, Terraform, environments, secret manager, Sentry, OTel.
2. Prisma schema + RLS policies + Prisma tenancy extension + cross-tenant test harness.
3. `packages/engine` with HS normalisation, tariff measure parser, customs value, apportionment, incoterm branching. 15 golden fixtures.
4. Tariff and FX adapters with cache, retry, breaker; nightly jobs.
5. Public calculator route (Phase 0) with rate sheet v1, rate limiting, Turnstile.

Everything else waits until the calculator has real traffic.
