# 0015. Payments partner, flow of funds, and the trade finance route

- **Status:** Decided by the founder on 2026-09-23, subject to written confirmation from Airwallex
  on the product features relied on, and from counsel on the regulatory points marked below.
  Closes decisions (p), (q) and (r).
- **Date:** 2026-09-23
- **Brief:** §1 (never hold client money), §6.3 (payments), §7.7 (compliance)

## Context

ADR-0012 prepared the supplier model for embedded payments without choosing a partner or a
regulatory route. Three decisions were open: which payments partner, how funds flow so the
platform never holds client money, and how to offer trade finance without becoming a regulated
lender.

## Decision

### Payments partner: Airwallex, platform product

- Reasons recorded: a platform product aimed at marketplaces and software platforms, native
  CNY routing and Alipay B2B rails that avoid SWIFT intermediary fees for payments to China, and
  the ability to add a platform FX margin on top of the partner's rate and present a single rate
  to the user.
- **To confirm with Airwallex before build:** the product name and tier available to a UK
  platform of our size; that the API supports a platform margin on the FX rate and sweeps it to
  a platform account automatically; that end users can hold their own wallet with Airwallex
  performing KYB; and the OAuth or connected-account model for delegated transfers.

### Flow of funds: the user's own wallet, delegated transfers

1. The user opens a wallet with Airwallex from inside our settings. Airwallex performs KYB and
   holds the balance. We store only the connection reference.
2. The user grants the platform a scoped token to initiate transfers from their wallet to
   beneficiaries they have added (ADR-0012: beneficiary details go straight to Airwallex).
3. A supplier payment debits the user's wallet. Airwallex pays the supplier and settles our FX
   margin to our platform account in the same transaction.

The principal never touches an account we control. **Counsel to confirm** that this keeps the
platform outside FCA payment services and e-money authorisation, and what disclosures the
"platform exchange rate" needs (the margin must be disclosed in our terms even if the rate is
shown as a single figure).

### Trade finance: partner lender, limited companies only

- We do not lend from our balance sheet. A B2B embedded lender (YouLend, Treyd, Outfund or
  similar) underwrites, funds the supplier and carries the regulatory liability; we earn a
  referral fee.
- **Companies House gate.** During onboarding the platform looks up the organisation's name
  with the Companies House API. The finance module is offered only when a company number is
  found, the company is active, and the type is a private or public limited company or an LLP.
  Sole traders and general partnerships never see the module. The check result and timestamp
  are stored on the organisation for audit; the user can correct the match.
- **Counsel to confirm:** that lending to limited companies and LLPs for business purposes
  falls outside consumer credit regulation as we understand it, and that introducing only such
  companies to a lender does not itself require credit-broking authorisation. Sole traders and
  partnerships of fewer than four partners borrowing under £25,000 are treated as regulated
  consumer credit, which is why they are excluded rather than served.

## Consequences

- ADR-0012's `PayoutMethod` stays partner-reference only. `Organization` gains
  `companiesHouseNumber`, `companiesHouseStatus`, `companyType` and `companiesHouseCheckedAt`
  when M2 builds the settings wizard; the Companies House lookup is an adapter with the usual
  timeout, retry and breaker, and an API key from configuration.
- Payments and finance remain a later phase with their own milestones, after the Airwallex
  confirmations and counsel's advice are on file.
- The onboarding copy in `docs/phase-1-workspace-ux.md` gains the company lookup step.
