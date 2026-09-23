# 0016. Supplier payments: connected accounts, delegated payouts, FX margin audit trail

- **Status:** Proposed design. No code until ADR-0015's confirmations from Airwallex and counsel
  are on file. Endpoint paths and field names below are illustrative and must be taken from the
  partner's current API reference at build time.
- **Date:** 2026-09-23
- **Brief:** §1, §3 (money as Decimal), §6.2 (idempotency, outbox), §6.4 (webhooks), §7.1
  (MFA for OWNER/ADMIN), §7.3 (encryption at rest, no bank details), §7.8

## Context

ADR-0015 chose Airwallex and a user-owned wallet. This ADR records how the account is
provisioned, how verification (KYB) is handed to the partner, how delegated access is stored,
how a payout is quoted and executed with the platform margin, and how the result reaches the
accounts payable ledger (ADR-0014).

## Decision

### `WalletProfile` (one per organisation)

- `partner` (enum, `AIRWALLEX`), `partnerAccountId` (the connected account id), `kycStatus`
  enum (`INCOMPLETE`, `PENDING_REVIEW`, `INFO_REQUIRED`, `ACTIVATED`, `SUSPENDED`, `CLOSED`),
  `kycUpdatedAt`, timestamps.
- Delegated access: `accessTokenCiphertext`, `refreshTokenCiphertext`, `tokenExpiresAt`,
  `tokenScopes`, `authorisedByUserId`, `authorisedAt`. **Changed:** tokens are envelope-encrypted
  with a per-organisation data key (§7.3) from day one, never held in plain columns, never
  logged, and revocable from settings. A token refresh is a background job, not a request-path
  side effect.
- **Changed:** the Companies House fields stay on `Organization` (ADR-0015), because company
  verification gates finance and is useful without a wallet.

### Provisioning and verification hand-off

1. "Set up supplier payments" (OWNER only) creates the connected account server-to-server with
   the platform credentials and stores `partnerAccountId`.
2. Verification uses the partner's hosted onboarding page or embedded component with a
   short-lived client secret. We collect no identity documents. The embedded component's origin
   is added to the CSP `frame-src` and `script-src` allow-list for that route only.
3. Status changes arrive by webhook and are mirrored to `kycStatus`; the user is emailed when
   the account is activated.
4. After activation the user authorises the platform through the partner's OAuth screen. The
   callback exchanges the code server-side and stores the encrypted tokens.

### `SupplierPayout` (the audit trail)

Per payout: `purchaseOrderId`, `walletProfileId`, `payoutMethodId` (ADR-0012 partner
beneficiary reference), `purpose` (`DEPOSIT`, `BALANCE`, `OTHER`), `sourceCurrency`,
`targetCurrency`, `targetAmount`, `partnerQuoteId`, `quoteExpiresAt`, `interbankRate`,
`marginPct`, `clientRate`, `sourceAmount`, `platformRevenue`, `partnerPayoutId`, `status`,
`initiatedByUserId`, `executedAt`, `settledAt`, `failureReason`, timestamps.

- Status enum: `QUOTED`, `EXPIRED`, `PROCESSING`, `SETTLED`, `FAILED`, `CANCELLED`.
- All money and rates are `Decimal` (rates `Decimal(18,8)`). The API payload is built from
  those values at the boundary.
- Margin arithmetic, all with the engine's `Decimal` and half-up rounding:
  `clientRate = interbankRate × (1 − marginPct/100)`;
  `sourceAmount = round2(targetAmount / clientRate)`;
  `platformRevenue = sourceAmount − round2(targetAmount / interbankRate)`.
  Worked example: $5,000 at 1.3000 with 0.5% → client rate 1.2935, source £3,865.48,
  interbank cost £3,846.15, revenue £19.33.
- The quoted figures are frozen on the row when the quote is shown, so the operating account
  reconciles against exactly what the user saw.

### Execution

- Preconditions, checked server-side in one transaction: wallet `ACTIVATED`, valid token, user
  role OWNER or ADMIN with `payment.execute`, **MFA enabled for that user** (§7.1 extended from
  booking to payments), quote not expired, PO not cancelled, beneficiary verified.
- Idempotency: the partner `request_id` is the `SupplierPayout.id`; the row and an outbox entry
  are written in one transaction and a worker makes the API call (§6.2), so a crash mid-flight
  never double-pays.
- The platform fee is passed in the payout instruction so the partner settles it to the
  platform account. We never receive the principal.
- On `PROCESSING`: set `executedAt`, and set `depositPaidAt` or `balancePaidAt` on the PO.
  **Changed:** no PO status change, because ADR-0013 keeps payment state off the status enum.
- Audit log: `payout.quoted`, `payout.executed`, `payout.settled`, `payout.failed`.

### Webhooks and the ledger

- `POST /webhooks/airwallex`: signature verified with a constant-time compare, timestamp
  replay window, payload size limit, enqueue and return 200 within 2 seconds, processing in the
  worker, idempotent on the partner event id, dead-letter queue (§6.4 pattern reused).
- On `SETTLED`: create a `BillPayment` (ADR-0014) against the supplier's bill for the PO with
  `fxRate = clientRate` and `amountGbp = sourceAmount`, so the variance engine sees the real GBP
  cost of goods including our margin. **Changed:** a payout is a payment of the supplier's
  invoice, not a new bill line.
- On `FAILED`: mark the payout, clear any paid-at set optimistically, alert ops, tell the user
  plainly without a stack trace.

### Tenancy and access

`WalletProfile` and `SupplierPayout` carry `organizationId`, row-level security and tenancy
allow-list entries. Payout initiation is limited to OWNER and ADMIN; VIEWER and MEMBER can see
payout history only.

## Consequences

- Adds `payment.execute` to the RBAC matrix and MFA to the OWNER/ADMIN requirements.
- The FX margin must be disclosed in the terms and shown next to the client rate in the UI
  (ADR-0015 counsel point).
- Field encryption (§7.3) becomes a prerequisite for this milestone, not a later improvement.
