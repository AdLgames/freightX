# Stripe webhook fixtures (M6)

**Hand-authored, not recorded.** These follow Stripe's documented object shapes for API version
`2026-08-26.dahlia` (the version pinned in `../stripe.server.ts`): a subscription's period end is
on its items, an invoice references its subscription through `parent.subscription_details`, and a
checkout session carries `client_reference_id`. They were written from the SDK's type definitions
because the build sandbox has no Stripe account; re-record them from the Stripe CLI
(`stripe trigger customer.subscription.updated`, `stripe events resend <id>`) before trusting them
as evidence that the processor matches live payloads, and again on every API version bump.

Placeholders (`{{ORG_ID}}`, `{{CUSTOMER_ID}}`, `{{SUBSCRIPTION_ID}}`, `{{PRICE_ID}}`,
`{{EVENT_ID}}`, `{{EMAIL}}`) are substituted by `loadFixture()` in `index.ts`. Amounts inside are
integer minor units as Stripe sends them; the processor never reads them.
