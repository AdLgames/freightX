# @harbour/web

Harbour's web app. React Router 7 framework mode, React 19, Vite 7, zod 4, TypeScript strict.

- **Phase 0:** the public landed-cost calculator (brief §2, §11 item 5). No login, no persistence
  beyond the Phase 0 gate metrics (`calculator.completed`, `signup.completed` log events).
- **Phase 1, M1:** magic-link sign-in, server-side sessions, CSRF, organisations and the
  workspace shell under `/app` (see "Workspace (M1)" below). The calculator does not depend on
  any of it and still runs with no `DATABASE_URL` and no `REDIS_URL`.

```
app/
  root.tsx                    layout, <Meta/><Links/><Scripts/>, error boundary (no stacks in prod)
  entry.server.tsx            streaming SSR, isbot, per-request CSP nonce + security headers
  routes.ts                   flatRoutes() from @react-router/fs-routes
  routes/_index.tsx           landing page + email signup form
  routes/calculator.tsx       the calculator (loader: lanes/currencies/Turnstile; action: the pipeline)
  routes/signup.tsx           POST-only email signup (zod, honeypot, 5/hour/IP)
  routes/healthz.tsx          GET → { ok, calcVersion, rateSheet, … }
  routes/login.tsx            M1: sign-in form; POST issues a magic link
  routes/login_.verify.tsx    M1: magic-link landing (GET renders a button, POST signs in)
  routes/logout.tsx           M1: POST only, destroys the session
  routes/onboarding.organization.tsx  M1: first organisation (org + OWNER + customs profile)
  routes/app.tsx              M1: workspace shell layout for /app/* (nav, org switcher, sign out)
  routes/app._index.tsx       M1: Home (action-required banner; M4 slots marked)
  routes/app.switch-org.tsx   M1: POST only, organisation switcher
  routes/app.{quotes,products,documents,settings}.tsx  placeholders owned by M4, M3, M5, M2/M6
  components/csrf.tsx         <CsrfProvider>, <CsrfInput/>
  components/workspace-nav.ts the workspace navigation (one array)
  components/quote-result.tsx result rendering (banner, totals, duty detail, warnings, provenance)
  data/ports.ts, countries.ts UN/LOCODE and ISO country display names
  validators/                 zod schemas: common.ts, calculator.ts, signup.ts (+ tests)
  services/
    app.server.ts             composition root (getApp()), memoised per process
    quote-pipeline.server.ts  resolveProducts → resolveFx → resolveFreight → resolveTariff → compute
    rate-limit.server.ts      token bucket: in-memory, or Redis (ioredis + Lua) when REDIS_URL is set
    turnstile.server.ts       Cloudflare Turnstile siteverify (5 s timeout, fail closed)
    logger.server.ts          JSON lines with request id and PII redaction (redact())
    db.server.ts              persistence seam for the calculator's stores (Prisma when DATABASE_URL)
    auth.server.ts            M1: requireUser, requireOrgContext, withOrg, withUser, sessions
    csrf.server.ts            M1: requireCsrf (token + Origin/Sec-Fetch-Site)
    session.server.ts         M1: SessionManager, Redis / in-memory stores, cookie
    magic-link.server.ts      M1: token issue/consume (sha256 in DB, single use)
    email.server.ts           M1: EmailTransport (console for dev, Resend)
    organizations.server.ts   M1: memberships, createOrganization, org-switch audit
    workspace.server.ts       M1: what the workspace needs at startup (fail closed)
    redis.server.ts           one Redis connection for rate limits and sessions
    page-error.ts             pageError(): 403/503 pages rendered by root's ErrorBoundary
    fx.server.ts, freight.server.ts, tariff.server.ts, env.server.ts, paths.server.ts,
    request.server.ts, security-headers.server.ts, signup-repository.server.ts
  styles.css                  one plain stylesheet, no framework, no external assets
```

## Run

The engine and adapters packages export their `dist/`, so build them once first:

```sh
pnpm install --ignore-scripts
pnpm --filter @harbour/engine --filter @harbour/adapters run build

pnpm --filter @harbour/web run dev        # http://localhost:5173
pnpm --filter @harbour/web run typecheck  # react-router typegen && tsc --noEmit
pnpm --filter @harbour/web run test       # vitest (also picked up by `pnpm test` at the root)
pnpm --filter @harbour/web run build      # → build/client, build/server
pnpm --filter @harbour/web run start      # react-router-serve ./build/server/index.js (PORT=3000)
```

Smoke test a built server:

```sh
PORT=3123 pnpm --filter @harbour/web run start &
curl -s localhost:3123/healthz
curl -s -o /dev/null -w '%{http_code}\n' localhost:3123/calculator
curl -s -X POST localhost:3123/calculator \
  --data-urlencode 'lane=CNSHA:GBFXT:SEA_LCL' -d incoterm=FOB -d hsCode=9503004100 \
  -d originCountry=CN -d quantity=500 -d unitPrice=4.50 -d currency=USD \
  -d unitWeightKg=0.8 -d unitVolumeCbm=0.004 | grep -o 'Total landed cost[^<]*'
```

## Environment

All optional (see the root `.env.example`):

| Variable                                      | Effect when set                                                   | When unset                                                            |
| --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`                                | Prisma stores (`db.server.ts`) and the workspace                  | in-memory calculator stores; workspace says "needs a database"        |
| `REDIS_URL`                                   | shared rate limiter (fails open) and session store (fails closed) | in-memory limiter and sessions; **production: workspace 503**         |
| `APP_URL`                                     | origin for magic links and the CSRF Origin check                  | request origin (dev/test); **production: sign-in not available**      |
| `EMAIL_TRANSPORT`                             | `console` (dev/test only) or `resend`                             | console outside production; **production: sign-in not available**     |
| `RESEND_API_KEY` / `EMAIL_FROM`               | Resend API key and sender, required by `EMAIL_TRANSPORT=resend`   | —                                                                     |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Turnstile widget + server-side verification (fail closed)         | bot check off, one warning at startup                                 |
| `FX_SEED_CSV`                                 | HMRC monthly CSV loaded into the FX store at startup              | adapters **sample** CSV, loud `fx.sample_rates` warning               |
| `RATE_SHEET_PATH`                             | freight rate sheet JSON                                           | `packages/adapters/rate-sheets/v1.json`, resolved through the package |
| `SESSION_SECRET`                              | unused (session ids are random and server-side; nothing signed)   | —                                                                     |
| `TRADE_TARIFF_API_KEY` / `…_HEADER`           | key sent in that header on every tariff call (both or neither)    | anonymous calls; only one of the two set → startup fails              |
| `BROKER_DEFERMENT_FEE_PCT` / `…_MIN_GBP`      | default forwarder deferment fee terms, prefilled in the form      | no default fee; the form says fee terms depend on the forwarder       |
| `INLAND_VAT_ADJUSTMENT_{LCL,FCL,AIR}_GBP`     | VAT-base padding by mode when the UK inland leg is unknown        | no adjustment                                                         |
| `NODE_ENV`, `LOG_LEVEL`                       | production hardening (HSTS), log verbosity                        | development / debug                                                   |
| `FIELD_ENCRYPTION_KEY` (M2)                   | master key for EORI/VAT field encryption (32 bytes, base64)       | ephemeral key + warning; **production: workspace 503**                |
| `COMPANIES_HOUSE_API_KEY` (M2)                | Companies House lookup in Settings › Organisation                 | lookup off; "sole trader or partnership" only                         |
| `FORWARDER_EORI` / `FORWARDER_NAME` (M2)      | shown in the CDS "authorise the forwarder" step                   | "{forwarder to be confirmed}"                                         |

`TRADE_TARIFF_API_KEY_HEADER` must be confirmed from the Trade Tariff developer portal before
use; the key is never logged (only its presence, in `app.started`). The fee and inland-adjustment
values are decimal strings with no built-in defaults: the proposed £170 LCL / £550 FCL inland
figures are unverified and deliberately not hard-coded. The rate sheet always gives the UK leg,
so the inland adjustment only affects fallback freight providers today.

The client IP for rate limiting is read from `Fly-Client-IP`, `CF-Connecting-IP`, `X-Real-IP`
or the first `X-Forwarded-For` entry — deploy behind a proxy that sets one, or every visitor
shares a single bucket. The IP is hashed before it becomes a bucket key and is never logged.

## Calculator inputs added with engine 1.1

- **Assists** (tooling, moulds, design paid separately): either a GBP amount for this shipment,
  or total cost + lifetime units, apportioned as cost × quantity ÷ units (Decimal, 2 dp half-up).
  Both at once is a field error. Added to the customs value (dutiable) and to the landed cost.
- **How duty is paid**: through the forwarder (broker deferment, default; optional fee % and
  minimum, prefilled from env), own duty deferment account (7-digit DAN + a required "I have
  authorised my forwarder's EORI" confirmation, which only drives a CDS reminder in the result),
  or CDS cash account. Fee terms apply only to broker deferment.
- **Postponed VAT accounting**: passed to the engine as ticked even without "VAT registered", so
  the `PVA_REQUIRES_VAT_REGISTRATION` warning shows instead of the tick being silently ignored.
- The result adds the assists row, the deferment fee, and "Cash needed at the border" (duty + VAT
  actually paid at the border; VAT excluded under PVA).

## What is and is not persisted

Phase 0 persists nothing from a calculation. Inputs are validated, priced and echoed back into
the form in the response, then discarded. The DAN is checked for format only: the validator drops
it before the pipeline, so it never reaches the quote, the logs or any store (and `dan` keys are
redacted by the logger regardless). The only calculator log line is `calculator.completed`, with
coarse fields (status, incoterm, mode, ports, HS chapter, duty-payment method, PVA flag, assist
method, warning codes) and no IP, email, EORI, VAT number or DAN. The only data kept is the email
signup list (see `db.server.ts`).

## What is stubbed or sample-only

- **Persistence**: everything is in memory. `app/services/db.server.ts` is the single file to
  change when `@harbour/db` is wired (`TariffCacheStore`, `FxRateStore`, `EmailSignupRepository`).
- **FX**: no worker job yet; rates come from `FX_SEED_CSV` or the sample CSV. If the sample's
  month has passed, it is re-stamped to the current month so dev keeps working — still sample data.
- **Freight**: rate sheet V1 with `placeholder: true`; the page shows a "preview rates" notice.
- **Tariff**: live calls to the UK Trade Tariff API with a 24 h in-memory cache; the recorded
  fixtures in `packages/adapters/fixtures` are hand-authored (see that README).
- **Turnstile**: off without a secret. Rate limiting still applies.
- **Platform fee**: 0 in Phase 0.
- Only single-line quotes; multi-line apportionment is exercised by the engine tests, not the UI.

## Security posture (§7.5)

- CSP `default-src 'self'; script-src 'self' 'nonce-…' https://challenges.cloudflare.com; …`,
  nonce minted per request in `entry.server.tsx` and passed via `<ServerRouter nonce>` (React
  Router's documented pattern: it becomes the default for `<Scripts>`/`<ScrollRestoration>`).
- HSTS (production only), `nosniff`, `Referrer-Policy`, minimal `Permissions-Policy`, `frame-ancestors 'none'`.
- No `dangerouslySetInnerHTML` (ESLint-enforced); React encodes all output.
- Honeypot + Turnstile + 20 calcs/hour/IP on the calculator; 5 signups/hour/IP.
- Structured logs never contain IPs, emails, EORI or VAT numbers (`redact()` is tested).
- Every pipeline failure degrades to an `INDICATIVE` quote or a form message; nothing 500s to the user.

## Workspace (M1)

### Sign-in (§7.1)

1. `/login` POST: zod email → Turnstile (when configured) → rate limits (20/hour per IP, 5/hour
   per address; buckets keyed by sha256 of the lower-cased address / the IP, then hashed again) →
   a 32-byte token whose sha256 is stored in `MagicLinkToken` for 15 minutes → email with
   `${APP_URL}/login/verify?token=…`. Every valid address gets the same answer ("If that address
   can sign in, we've sent a link"); no `User` is created until a link is confirmed.
2. `/login/verify` GET renders a "Sign in" button and does not touch the token (mail scanners
   prefetch links). The POST marks the token used with one conditional `UPDATE … WHERE usedAt IS
NULL AND expiresAt > now` (count must be 1), creates the user on first sign-in, writes a
   tenant-less `auth.sign_in` audit row and starts a new session.
3. No memberships → `/onboarding/organization` (organisation name only; the EORI/VAT/customs
   wizard is M2).

### Sessions

`session.server.ts`. Id = 32 random bytes in cookie `__Host-harbour_sid` (`HttpOnly; Secure;
SameSite=Lax; Path=/`, 30-day `Max-Age`); `NODE_ENV=development` over plain http uses
`harbour_sid` without `Secure`, because browsers reject `__Host-` cookies that are not Secure.
The store key is sha256(id); the value is `{ userId, currentOrgId, role, csrfToken, createdAt,
lastSeenAt, rotatedAt }` (`role` is the role last seen for `currentOrgId`, so a role change made by
someone else rotates the session on the next request). 30-day sliding expiry, refreshed at most
once an hour (the /app layout re-issues the cookie then). The id rotates on sign-in, organisation
switch, onboarding and role change. `POST /logout` destroys it.

- `REDIS_URL` set → `RedisSessionStore` on the same connection as the rate limiter.
- Unset in development/test → `InMemorySessionStore` (single process; lost on restart).
- Unset in **production** → every workspace route returns 503 "Workspace temporarily unavailable"
  and one error is logged at startup. There is deliberately no in-memory fallback: on Vercel each
  serverless instance would have its own sessions, so users would be signed out at random. The
  calculator is unaffected.
- A Redis error while reading or writing a session is a 503, never "signed out".

### Tenancy (§7.2, ADR-0009)

`requireOrgContext` takes the organisation from the session and re-reads the membership on every
request inside `withOrgTransaction`. A missing membership (removed, organisation deleted, or a
tampered session) rotates the session onto another membership or to onboarding. URL params and
form fields never choose the organisation; the org switcher's field is only a request, checked
against memberships before the session changes.

### Extension points for later milestones

- **Add a nav item:** one entry in `app/components/workspace-nav.ts` (`{ to, label,
permission? }`), plus your own route file `app/routes/app.<name>.tsx` (it renders inside the
  shell). Replace the placeholder file your milestone owns rather than editing someone else's.
- **Declare a route's permission:** every loader and action starts with
  `const ctx = await requireOrgContext(request, { permission: 'quote.edit' })` (actions from the
  RBAC matrix in `@harbour/db` `rbac.ts`). Missing permission → 403 page. Hiding a nav item is
  not a check; the route must call this itself. `assertPermission(ctx, action)` checks a second
  action later in the same handler.
- **Database access:** `await withOrg(ctx, (tx) => tx.product.findMany())`. Everything that touches
  a tenant table goes through `withOrg` (Prisma tenant scope + `app.current_org` for RLS). With
  FORCE RLS, a query outside it sees no rows. `withUser(ctx, fn)` is only for the user's own
  memberships/organisations.
- **Mutating forms:** render `<CsrfInput />` inside every `<Form method="post">` under `/app` (the
  shell provides the token); in the action, `const form = await readForm(request); await
requireCsrf(request, form, ctx.session);` before anything else. Forms outside `/app` wrap
  themselves in `<CsrfProvider token={…}>` (see onboarding).
- **Audit:** state changes call `recordAudit(tx, { organizationId: ctx.org.id, userId:
ctx.user.id, action: 'product.create', targetType: 'Product', targetId })` with the `tx` from
  `withOrg`, so the audit row commits with the change. IDs and enum values only in `metadata`.
- **Privilege changes** (e.g. M2 changing a member's role): the affected user's session rotates on
  their next request automatically; an action that changes the current user's own org or role
  calls `rotateSession(ctx, request, patch)` and returns its `Set-Cookie`.
- **Error pages:** `throw pageError(status, title, message)` from `services/page-error.ts`.

### Not in M1

Passkeys and TOTP (§7.1), invalidating sessions on email change (no email change yet), the
settings wizard (M2), recent drafts / quick duty check on Home (M4). Magic-link rows are not yet
cleaned up (TODO for the worker, see packages/db README).

## Billing (M6)

Stripe Billing subscriptions (brief §3), OWNER only (§7.2 `billing.manage`). Files:
`routes/app.settings_.billing.tsx` (page + checkout/portal actions), `routes/app.settings_.billing_.success.tsx`,
`routes/webhooks.stripe.tsx` (public resource route), `services/billing/*`, `validators/billing.ts`,
`components/plan-notice.tsx`, migration `0006_billing`.

### Environment

| Variable                                    | Effect when set                                                            | When unset                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                         | `StripeGateway` (API version pinned in `stripe.server.ts`)                 | billing page says "Billing is not configured"; everything else unchanged   |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` | the Stripe price ids for the two paid plans (`price_…`)                    | same as above (both are required for checkout)                             |
| `STRIPE_WEBHOOK_SECRET`                     | `POST /webhooks/stripe` verifies signatures with it                        | the webhook answers 503 so Stripe keeps retrying                           |
| `REDIS_URL`                                 | webhook events go on the BullMQ `stripe-events` queue, consumed in-process | events are processed inline before the 200 (logged `billing.event_inline`) |

Plan names and prices are **read from Stripe** (`prices.retrieve` with the product expanded, cached
5 minutes) and never written in code. `billing.configured` at startup reports presence only.

### Flow

1. `/app/settings/billing` shows the effective plan (`Organization.plan`), status, renewal date and,
   while the organisation has no subscription, "Choose Starter" / "Choose Pro". The POST (CSRF)
   creates the Stripe customer on first use (`metadata.organizationId`, the owner's address as
   billing email, stored lower-cased in `billingEmail` — PII, never logged), then a Checkout Session
   (`mode: subscription`, `client_reference_id = organizationId`, the same id in `subscription_data.metadata`,
   `allow_promotion_codes`), audits `billing.checkout_started` and redirects. "Manage subscription"
   creates a Billing Portal session (return URL = the page), audits `billing.portal_opened` and redirects.
2. `/app/settings/billing/success?session_id=` retrieves the session server-side and 404s unless its
   `client_reference_id` is this organisation. It only confirms; the webhook is the source of truth.
3. `POST /webhooks/stripe` (no CSRF — signature-authenticated; outside `/app`): body ≤ 256 KB (413),
   `Stripe-Signature` required (400), verified with `stripe.webhooks.constructEvent` (HMAC, constant-time,
   300 s replay window → 400), then one `stripe_events` row per event id (`ON CONFLICT DO NOTHING`:
   a duplicate delivery is 200 and a no-op), enqueue, 200.
4. Processor (`services/billing/events.server.ts`, pure over `BillingRepository`): `checkout.session.completed`
   links customer/subscription/email; `customer.subscription.created|updated` maps price id → plan
   and Stripe status → `SubscriptionStatus`, sets `currentPeriodEnd`/`cancelAtPeriodEnd` (PAST_DUE
   keeps the plan; canceled/unpaid/incomplete/paused → FREE); `…deleted` → FREE + CANCELED;
   `invoice.payment_failed` → PAST_DUE and emails every OWNER "Payment failed — update your card"
   with a link to the billing page; `invoice.paid` clears PAST_DUE. Unknown types are marked
   processed and ignored. Every change writes audit `billing.subscription_updated` with
   `{ plan, status }` only. The organisation comes only from the event's `client_reference_id` /
   `metadata.organizationId`; a customer that does not match the organisation's, or a missing id,
   is recorded as `unresolved: …` on the row and never applied (no cross-tenant lookups).
   A thrown error (unmapped price id, database down) is recorded in `stripe_events.error`, the
   claim is released on the inline path (Stripe redelivers), and on BullMQ the job retries 5×
   then is kept in `failed` and logged as `billing.event_dead_lettered` (error level).
5. Gating: `requirePlan(ctx, 'STARTER')` (402 page) and `currentPlan(ctx)` in
   `services/billing/plan.server.ts`; `planAllows(plan, feature, count)`, `minimumPlanFor` and the
   provisional `PLAN_LIMITS` table in `plan.ts` (decision (z)); `<PlanNotice feature requiredPlan/>`
   renders "Upgrade to Starter to save more than 3 quotes." Not wired into other milestones' routes.

### Local development

```sh
stripe login
stripe listen --forward-to localhost:5173/webhooks/stripe     # prints whsec_… → STRIPE_WEBHOOK_SECRET
stripe prices list                                             # → STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO
stripe trigger customer.subscription.updated                   # or complete a checkout with a test card
```

Test cards (Stripe test mode): `4242 4242 4242 4242` succeeds; `4000 0000 0000 0341` attaches but
fails the first invoice (exercises `invoice.payment_failed`); `4000 0000 0000 3220` requires 3-D
Secure. Any future expiry, any CVC. Test-mode price ids start with `price_` like live ones — keep
the two environments' keys apart (§7.6).

Tests: `services/billing/*.test.ts` and `validators/billing.test.ts` need no database; the
`fixtures/` are hand-authored in Stripe's documented shape (see their README) and substituted per
test organisation. `routes/webhooks.stripe.db.test.ts` and `routes/app.settings_.billing.db.test.ts`
run with `DATABASE_URL` (superuser or `harbour_app` member) on a `FakeBillingGateway`, covering
signature/size/replay/duplicate rules, OWNER-vs-ADMIN, CSRF, audit rows, the cross-tenant negative
and a no-PII log snapshot.

## Documents (M5)

Brief §7.4. Routes `app/routes/app.documents*.tsx` and `files.*.tsx`, services
`app/services/documents/`, validators `app/validators/documents.ts`, storage/scan adapters in
`packages/adapters/src/storage/`, scan job in `apps/worker/src/jobs/document-scan.ts`, migration
`0005_documents_quote_link`.

### Environment

| Variable                                                               | Effect when set                                                                                                | When unset                                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | `S3ObjectStorage` (AWS S3, or Cloudflare R2 with `STORAGE_ENDPOINT`; `STORAGE_REGION` defaults to `auto` then) | outside production: `LocalDiskObjectStorage` under `STORAGE_LOCAL_DIR` (default `.data/storage`); **production: "Document storage not configured" (503) for /app/documents only** |
| `STORAGE_ENDPOINT` / `STORAGE_FORCE_PATH_STYLE`                        | R2/MinIO endpoint; path-style is the default with an endpoint                                                  | AWS virtual-hosted URLs                                                                                                                                                           |
| `STORAGE_LOCAL_DIR` / `STORAGE_LOCAL_SECRET`                           | local backend directory and HMAC secret for `/files/*` URLs                                                    | `.data/storage`; secret derived from `SESSION_SECRET` or a fixed development value                                                                                                |
| `CLAMD_HOST` / `CLAMD_PORT`                                            | `ClamdScanner` (INSTREAM over TCP, 60 s budget)                                                                | `NoScanner`: type + size check only, documents stay **Uploaded**, never **Clean**                                                                                                 |
| `REDIS_URL`                                                            | scan jobs go to the `document-scan` BullMQ queue for `apps/worker`                                             | the scan runs in-process after the response, with a `document_scan.inline` log line                                                                                               |

A partial S3 configuration (e.g. only the bucket) disables the vault too — fail closed, one
`documents.storage_unavailable` error at startup. With S3 the presigned upload origin is added to
the CSP as `connect-src 'self' <origin>` (`entry.server.tsx`, derived from the same env); the local
backend is same-origin and needs nothing.

### Upload flow

1. `GET /app/documents/new` (`doc.upload`): type, target (the organisation, or one of its
   quotes — M4 links here with `?quoteId=`), file.
2. With JavaScript (`public/documents-upload.js`, served from our origin so it needs no nonce):
   `POST /app/documents/presign` (CSRF, metadata only) validates extension + declared MIME
   (PDF/PNG/JPG/XLSX/CSV, ≤ 25 MB), creates the `Document` row in `UPLOADED` with a sanitised
   name and key `orgId/{quote|org}/docId`, and returns a 5-minute presigned PUT whose
   Content-Type is part of the signature. The browser PUTs the bytes straight to storage, then
   `POST /app/documents/:id/complete` (CSRF): `head()` must find the object at the declared size
   → `SCANNING`, audit `doc.upload`, scan job. Without JavaScript the same form posts the file to
   the app, which spools it and puts it into storage server-side with the same limits — the no-JS
   and development path only.
3. Scan (`@harbour/adapters` `runDocumentScan`, run by the worker or inline): sha256, magic
   bytes (`%PDF-`, PNG, JPEG, ZIP + `[Content_Types].xml` for XLSX, NUL-free valid UTF-8 for CSV)
   must match the declared type, then the malware scanner.
   - mismatch, size disagreement or scanner `FOUND` → **Rejected** with `rejectedReason`; the
     object is deleted before the row is updated;
   - scanner ran clean → **Clean** (`scanEngine = clamav`);
   - no scanner → stays **Uploaded** with `scanEngine = none`, `scanResult = not_scanned`. The UI
     says "Type and size checked. Not virus-scanned." This is deliberately not Clean: booking
     (§6.1) needs Clean or Verified, so unscanned documents block it.
4. **Verified** = an OWNER/ADMIN confirmed a Clean document (`doc.verify`). Uploading the same type
   for the same target again creates version n+1 and keeps the history.

Download: `GET /app/documents/:id/download` (`doc.download`, audit `doc.download`) → 302 to a
5-minute presigned GET with `Content-Disposition: attachment; filename="<sanitised>"`. Delete
(`doc.upload`): soft (`deletedAt`), object removed, audit `doc.delete`. The vault lists missing
files per accepted quote (commercial invoice, packing list), documents by quote, and organisation
documents (EORI confirmation, VAT certificate, representation authority). Original file names are
kept for display only and never logged (`originalName` is a redacted log key).

## Settings (M2)

Routes under `/app/settings` (`app.settings.tsx` is the layout; M6 adds `app.settings.billing.tsx`
inside it): Overview, **Organisation** (`app.settings.organisation.tsx`), **Customs profile**
(`app.settings.customs.tsx`), **Members** (`app.settings.members.tsx`), **Audit log**
(`app.settings.audit.tsx`), and the invitation landing page `invite.accept.tsx`. Services live in
`app/services/settings/`, schemas in `app/validators/settings.ts`. Every POST carries `<CsrfInput/>`
and an `intent` field; every loader/action starts with `requireOrgContext` and uses `withOrg`.

| Variable                  | Effect                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIELD_ENCRYPTION_KEY`    | 32 random bytes, base64 (`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`). Master key of the envelope encryption in `@harbour/db` `crypto.ts`. Production without it → every workspace route is 503 "Workspace not configured" (the calculator is unaffected); development/test → an ephemeral key and a `settings.field_encryption_ephemeral` warning. The worker needs the same value. |
| `COMPANIES_HOUSE_API_KEY` | Enables "Is your business a limited company?" (search + confirm). HTTP Basic, key as username. Unset → only "I'm a sole trader or partnership".                                                                                                                                                                                                                                                                             |
| `FORWARDER_EORI`          | The forwarding partner's EORI shown in step 4 (validated as an EORI). Unset → `{forwarder to be confirmed}`.                                                                                                                                                                                                                                                                                                                |
| `FORWARDER_NAME`          | The forwarding partner's name in the CDS confirmation checkbox. Unset → `{forwarder to be confirmed}`.                                                                                                                                                                                                                                                                                                                      |
| `REDIS_URL`               | Also picks the BullMQ `JobEnqueuer` (`settings/jobs.server.ts`) that queues `eori-verify` / `vat-verify` for the worker. Unset → an in-memory enqueuer that only logs `jobs.enqueue_skipped`; numbers stay "pending".                                                                                                                                                                                                       |

- **Organisation:** name and base currency (`org.update` audit: `nameChanged`, `baseCurrency`);
  EORI (`^(GB|XI)\d{12}$`, whitespace stripped, upper-cased) and VAT registration (yes/no + VRN
  with the check digit). Both numbers are encrypted before they are stored (`identity.server.ts`):
  the columns hold ciphertext, `eoriLast4` / `vatLast4` are shown, the status goes to `PENDING`
  and the verification job is queued after the transaction commits. Audit `org.eori.update` /
  `org.vat.update` carry the last four only. Only OWNER/ADMIN (`org.tax_ids.edit`) may change
  them; everyone else sees a read-only page. Clearing the VAT registration while the customs
  profile uses PVA is refused (pre-check + the 0003 trigger as backstop).
- **Company lookup (ADR-0015 step 1b):** searches Companies House by name, shows "Is this you?"
  matches, and on confirmation re-reads the company profile from the API (never trusts the form)
  and stores number/status/type/name/checked-at; "sole trader or partnership" stores a check time
  with no number. Audit `org.company.confirm` with the number, status and type (public registry
  data). `isEligibleForFinance` (adapters) is only surfaced as a hint; nothing is gated in M2.
- **Customs profile:** the wizard's steps 2–4 with the corrected copy (forwarder pays and
  invoices; fee from the forwarder's terms, `BROKER_DEFERMENT_FEE_PCT`/`_MIN_GBP` prefilled when
  the profile has none; PVA changes when VAT is paid, not what goods cost; the forwarder's EORI is
  the one to authorise; CDS authority gates booking, not quoting). PVA needs a VAT registration
  (friendly field error; the DB trigger is the backstop); own deferment needs a 7-digit DAN; the
  CDS checkbox sets `cdsAuthorityGranted`, `cdsAuthorityConfirmedAt` and `…ById` and is cleared
  when the payment method changes away. The DAN is validated, stored in clear (see packages/db
  README for the encryption follow-up) and never logged or audited. Audit
  `org.customs_profile.update` (flags and enums) and `org.cds_authority.confirm`.
- **Members:** list with roles; OWNER/ADMIN (`member.manage`) invite by email + role (only an
  OWNER may grant OWNER), change roles (never your own; an OWNER may only be demoted by an OWNER;
  the last OWNER is protected), remove members (bumps `users.sessionEpoch`, which signs that user
  out everywhere on their next request) and revoke invitations. Invitations: 7-day link
  `/invite/accept?token=<org id>.<secret>` sent through the `EmailTransport`; only the sha256 of
  the secret is stored; accepting requires being signed in as that address (a signed-out visitor
  goes through the magic link and lands back on the invitation). Audit `invitation.create` /
  `.accept` / `.revoke`, `membership.create` / `.role_change` / `.delete` — ids and roles only.
- **Audit log:** OWNER/ADMIN (`audit.view`), 25 per page, newest first; actor names resolved on
  screen only.
- **Verification status** (`UNVERIFIED` → `PENDING` → `VALID` / `INVALID` / `ERROR`) is written by
  the worker (apps/worker README "Identity verification jobs"); the page shows the badge and the
  check time.

Tests: `validators/settings.test.ts`, `services/settings/*.test.ts` (enqueuer, startup guards) and
`routes/settings-flow.db.test.ts` (with `DATABASE_URL`: encrypted storage, PVA/DAN rules, company
confirmation, the invitation flow incl. expiry/revoke/wrong address, role rules, member removal
signing out, cross-tenant negatives and the no-PII log snapshot).

## Phase 1 TODO (not built — brief §2, §7)

- Auth: passkeys (WebAuthn), optional TOTP.
- Products, suppliers, HS code verification stored as `hsCodeVerifiedAt`.
- Saved quotes: persist `QuoteResult` snapshots, `ACCEPTED` immutability, hourly expiry job.
- Document vault: presigned uploads, AV scan, magic-byte checks.
- ~~Stripe Billing subscription and plan gating~~ (M6, see "Billing (M6)").
- Document vault: built in M5 (see "Documents (M5)"); ClamAV container and R2 vs S3 are open decisions.
- Stripe Billing subscription and plan gating.
- Worker (`apps/worker`): HMRC/ECB FX jobs, tariff cache refresh, quote expiry.
- SeaRates behind `ResilientFreightProvider` with the rate sheet as fallback and outlier checks.

## Deploying to Vercel

Vercel project settings:

- **Root Directory:** `apps/web`. Keep "Include files outside the root directory" enabled, which
  is the default, so the pnpm workspace installs.
- **Node.js version:** 22.x. `engines.node` is `22.x`, and Vercel follows it.
- Everything else comes from `apps/web/vercel.json`: the React Router framework preset, the
  `vercel-build` command that builds the engine and adapters first, and the London region
  (`lhr1`, for UK hosting per brief §10).

`react-router.config.ts` enables `@vercel/react-router`'s preset only when `VERCEL` is set, so
local dev and `react-router-serve` hosting are unchanged. The default rate sheet and sample FX
CSV are bundled into the server build, so no runtime file paths are needed. `RATE_SHEET_PATH` and
`FX_SEED_CSV` still override them where a filesystem is available.

Serverless caveat: the in-memory rate limiter and stores are per function instance. Set
`REDIS_URL` so the 20-calculations-per-hour limit holds across instances, and set the Turnstile
keys before any public traffic. The workspace goes further: in production it refuses to start
sessions without `REDIS_URL` (503), because per-instance sessions would sign users out at random.
It also needs `DATABASE_URL`, `APP_URL` and `EMAIL_TRANSPORT=resend` with `RESEND_API_KEY` and
`EMAIL_FROM`.

## Catalogue (M3)

Products and suppliers under `/app/products` and `/app/suppliers` (docs/phase-1-workspace-ux.md
"Products (catalogue)", ADR-0012). Both pages are a list layout with the add/edit **drawer** as a
child route (`app.products.new.tsx`, `app.products.$productId.tsx`, `app.suppliers.new.tsx`,
`app.suppliers.$supplierId.tsx`) rendered beside the table on wide screens and above it on narrow
ones. Every form is a plain `<Form method="post">` with `<CsrfInput/>` and an `intent` button, so
the whole catalogue works with JavaScript off. Any member may view; every mutation needs the
`catalogue.edit` RBAC action (OWNER/ADMIN/MEMBER; VIEWER gets the 403 page).

```
routes/app.products.tsx            list (SKU, name, supplier, origin, HS code + verified mark, value, CBM, kg), search, archived filter
routes/app.products.new.tsx        add product; routes/app.products.$productId.tsx  edit / archive / restore
routes/app.suppliers.tsx           list; routes/app.suppliers.new.tsx  add; routes/app.suppliers.$supplierId.tsx  edit + pickup locations + payment terms
routes/app.api.hs-lookup.tsx       POST, JSON: the HS code field's live lookup (CSRF, 10/min per user)
components/catalogue/              drawer, field helpers, product form, supplier forms, HS code field + its client module
services/catalogue/
  hs-lookup.server.ts              lookupHsCode(): 10 digits → commodity summary; 6/8 → candidates; never guesses
  product-form.server.ts           shared product-form logic: verifyForSave(), "Check code", rate-limited lookup
  products.server.ts               list/get/create/update/archive/restore with audit rows
  suppliers.server.ts              supplier, pickup locations (one default), payment terms (one per supplier)
  snapshot.server.ts               productToQuoteLineSnapshot(product, qty) → engine LineInput (used by M4)
validators/product.ts, supplier.ts zod schemas; cbmFromCarton() (Decimal, 4 dp half-up)
data/countries-all.ts              every ISO 3166-1 alpha-2 code (the calculator keeps its short list)
```

### HS code field (§5.2, ADR-0006)

- Spaces and dots are stripped; 6, 8 or 10 digits are accepted; 9 or 11 are rejected with a message.
- **10 digits** → `lookupCommodity` through the app's cached tariff client (24 h): the official
  description, third-country duty, VAT rate and a `preferenceEligible` hint (a 142 measure exists
  for some origin — informational; the engine decides per origin at quote time).
- **6 or 8 digits** → `headingCandidates` + `normaliseHsCode`: the declarable 10-digit children with
  descriptions and duties, shown as radios (`hsCodeChoice`) for the user to pick. A single child is
  still a candidate. The product is never saved with a 6/8-digit code.
- Progressive enhancement: without JavaScript the "Check code" submit (`intent=check-hs`) runs the
  same lookup in the action and re-renders the result. With JavaScript,
  `components/catalogue/hs-lookup-client.ts` (bundled and loaded through `<Scripts nonce>`; no
  inline scripts, no inline handlers, no `innerHTML`) debounces typing (400 ms) and POSTs to
  `/app/api/hs-lookup` with the form's CSRF token.
- Rate limit: 10 lookups per minute per **user** (`TARIFF_LOOKUP_LIMIT`, keyed by user id through
  the shared limiter); the endpoint answers 429 with `Retry-After`, the form says so.
- **On save** `hsCodeVerifiedAt`, `hsDescription` and `preferenceEligible` are set only when the
  lookup succeeded for the exact 10-digit code being saved (`verifyForSave`). An unchanged, already
  verified code is kept without a new lookup. If the tariff service is down, the code is not found,
  or the user is over the limit, the product saves **unverified** and the list banner says why
  (`?notice=saved-unverified&reason=…`). Unverified codes show an amber mark: quotes using them are
  `INDICATIVE` until verified.

### Products

Three sections mapped to the Prisma `Product` model: Identity (SKU unique per organisation —
the DB unique violation comes back as a field error — name, supplier), Sourcing (origin from the
full ISO list, unit value ≤ 4 dp, currency incl. JPY), Logistics and compliance (kg per unit,
CBM per unit **or** carton L×W×H cm + units per carton → CBM computed with Decimal, 4 dp half-up,
e.g. 40×30×25 cm ÷ 12 = 0.0025; the carton dimensions are stored so the volume can be recomputed).
Products are **archived, never deleted**: quote lines snapshot them but keep the reference. Audit:
`product.create` / `product.update` (changed field names) / `product.archive` / `product.restore`.

### Suppliers (ADR-0012)

Legal identity (`legalName`, `tradingName`, `registrationNumber`, `countryOfIncorporation`),
sourcing defaults (`defaultCurrency`, `defaultIncoterm`), pickup locations (address, country,
closest port from the rate-sheet allow-list **or** a typed 5-character UN/LOCODE; the first one is
the default, "Make default" moves it, the DB allows one per supplier) and payment terms (one row per
supplier: `PREPAID`, `NET` + days, `DEPOSIT_BALANCE` + deposit % + balance trigger). `Supplier.name`
is the display name (trading name, else legal name). `countryCode` is written alongside
`countryOfIncorporation` as a deprecated alias until M4 (decisions-needed (w)). `PayoutMethod`
exists in the schema only — nothing writes partner references until a payments partner is signed.
Audit: `supplier.create/update/archive/restore`, `pickup_location.create/update/delete`,
`payment_terms.update`. Metadata carries ids, enum values and field names only — never names,
SKUs, addresses or registration numbers (and the log snapshot test checks the logs).

### Tests

`validators/product.test.ts`, `validators/supplier.test.ts`, `services/catalogue/*.test.ts` run
without a database. `routes/catalogue.db.test.ts` (with `DATABASE_URL`, superuser or `harbour_app`
member) drives the routes end to end with the recorded tariff fixtures
(`test-support/tariff-fixtures.ts`): endpoint results and the 429 on the 11th call, product CRUD,
SKU uniqueness, archive, unverified save when the fetch fails, VIEWER denied, pickup default
uniqueness and the payment-terms CHECKs, cross-tenant negatives through the routes, the services
and raw SQL under RLS, and the no-PII log rule.

## Quotes (M4)

Routes: `/app/quotes` (list, `app.quotes.tsx`), `/app/quotes/new` and `/app/quotes/:id/edit`
(the builder, `app.quotes_.new.tsx` / `app.quotes_.$id_.edit.tsx`), `/app/quotes/:id` (detail and
actions, `app.quotes_.$id.tsx`), `POST /app/api/quick-duty` (JSON). Services in
`app/services/quotes/`, schemas in `app/validators/quote.ts`, components in
`app/components/quotes/`. Every loader/action starts with `requireOrgContext` and reads tenant
rows through `withOrg`; every POST carries `<CsrfInput/>`.

### Builder

- **Pipeline.** `services/quotes/pipeline.server.ts` extends the Phase 0 calculator pipeline to
  catalogue lines: resolveProducts (rows → `productToQuoteLineSnapshot`) → resolveFx (every
  currency on the quote, one optional manual override) → resolveFreight (rate sheet for the whole
  shipment) → resolveTariff (once per distinct HS code, through the calculator's exported
  `resolveTariffStage`) → `computeQuote`. A 6/8-digit product code is never resolved here: the
  10-digit choice belongs on the product, so the line is marked unavailable and the quote is
  indicative. Unverified products give `HS_UNVERIFIED` → `INDICATIVE`, as in the calculator.
- **Inputs.** Supplier (optional; pre-fills the incoterm and the origin port from its default
  pickup location's `closestPortCode` — duty origin always comes from each product), incoterm
  radios with plain-English labels, route and mode from the rate-sheet lanes, lines added from
  the catalogue (quantity, per-line assists and preference claim; HS code, origin, value,
  currency, weight and volume are read-only with an "Edit product" link), insurance premium,
  include-origin-fees (FCA/FOB), the supplier's freight breakdown (DAP/DPU), a manual FX rate for
  one currency, VAT registered / PVA and the duty payment method with broker fee terms — all
  defaulted from the organisation and its customs profile (`readCustomsProfile`; env defaults
  `BROKER_DEFERMENT_FEE_PCT`/`_MIN_GBP` when the profile has none).
- **Progressive enhancement.** The form is flat HTML (`line_<i>_<field>`) and every button is a
  submit with an `intent` (`recalculate`, `add-line`, `apply-supplier`, `save`) or a `removeLine`
  index, so it works with no JavaScript by full-page re-render. After hydration
  `components/quotes/live-preview-client.ts` debounces changes (500 ms) and posts the same form
  to `?preview=1` through a React Router fetcher; the returned view is rendered by React into
  the sticky "True cost" column (no inline scripts or handlers, no `innerHTML`; the bundle is
  loaded through `<Scripts nonce>`). The route's `shouldRevalidate` skips loader re-runs for
  previews.
- **Rate limit.** 60 requests per minute per user (`QUOTE_LIMIT`) on preview, recalculate, save
  and the detail actions; a 429 carries `Retry-After`. Tariff lookups inside a quote go through
  the 24-hour cache and do not consume the 10/min tariff bucket; the quick duty check does.

### Saved quotes (snapshots)

- `saveQuote` writes the engine's `QuoteResult` column-for-column onto `Quote`/`QuoteLine`
  (`quoteData`, `lineData`); `quoteRowToResult` is the inverse and is tested for an exact
  string round trip on every money column (`routes/quotes.db.test.ts`). `paymentMethod` and
  `vatPostponed` are snapshotted from the customs profile in force. Lines copy the product's HS
  code, origin, unit value, currency, weight and volume; the product row is referenced only for
  its label.
- Migration `0011_quotes_phase1` adds `quotes.builder_input` (JSONB): the builder's inputs as
  entered (product ids, quantities, flags, decimal strings, `version: 1`), used only to reopen a
  draft and to recompute it. It is never read for money. Line order is the builder-input order
  (`orderedLines`); `quote_lines` has no position column.
- **Status (§5.9).** The builder saves `DRAFT`. On the detail page: **Update to current catalogue
  values** (DRAFT stays DRAFT, `recomputeQuote`), **Finalise** (DRAFT → the engine's `READY` or
  `INDICATIVE`), **Reopen as draft** (INDICATIVE/READY → DRAFT), **Accept** (READY only, roles
  OWNER/ADMIN via `quote.accept`; sets `acceptedAt`), **Cancel** (any live status; cancelling an
  accepted quote needs `quote.accept`). Editing is only offered for drafts. After acceptance the
  database trigger (migration 0002) refuses every change; `quoteDbError` maps its message to a
  friendly "accepted and can no longer be changed" error and `replaceQuote` refuses before
  touching the row. `expireDrafts` is the worker's job (not built here).
- **Audit** (`recordAudit`, ids and statuses only): `quote.create`, `quote.update` (edit, recompute,
  finalise, reopen — with `from`/`to`), `quote.accept`, `quote.cancel`.
- **Reference.** `Q-` + the first eight characters of the id, upper-cased (`quoteReference`); see
  decisions-needed (af) for a per-organisation sequence instead.
- **Plan limit (M6).** FREE allows `PLAN_LIMITS.FREE.savedQuotes` (3) saved quotes: DRAFT,
  INDICATIVE, READY and ACCEPTED count (`COUNTED_STATUSES`), CANCELLED and EXPIRED do not. The
  builder shows `<PlanNotice/>` at the limit and a save is answered with 402 and the notice
  (recalculating and previewing stay allowed). The number lives only in `PLAN_LIMITS`.
- **Documents (M5).** The detail page links to `/app/documents/new?quoteId=<id>` and, for accepted
  quotes, lists the required documents still missing (commercial invoice, packing list).

### Home widgets

- **Recent drafts** link to `/app/quotes/:id/edit`; **New quote** to `/app/quotes/new`.
- **Quick duty check** (`components/quotes/quick-duty-card.tsx`, `services/quotes/quick-duty.server.ts`):
  HS code + invoice value (GBP) + origin → the tariff's duty %, anti-dumping %, VAT % and the
  duty/VAT on that value with the engine's warnings (preference available, ADD, quota…). It posts
  to Home itself (`/app?index`, `intent=quick-duty`) so it works without JavaScript, and
  `/app/api/quick-duty` serves the same function as JSON. Same tariff client and 24-hour cache,
  same 10-per-minute-per-user limit as the HS code field; ambiguous tariffs are reported, never
  priced at 0%; a 6/8-digit code lists the 10-digit candidates for the user to pick. Nothing is
  saved. When the tariff service is unreachable the card says so.

### Tests

`validators/quote.test.ts`, `services/quotes/pipeline.server.test.ts` (fixture tariff, sample
FX, rate sheet v1; multi-currency lines, INDICATIVE on unverified codes, manual FX, DAP without
breakdown, broker fee terms) and `routes/quotes.db.test.ts` (with `DATABASE_URL`: builder intents
and preview, the exact snapshot round trip, save/list/detail/Home, edit, RBAC, cross-tenant
negatives incl. a foreign product id, finalise/accept/reopen/cancel, the immutability trigger
rendered friendly, recompute on drafts only, the 60/min and 10/min limits, the FREE plan limit,
the quick duty check and the no-PII log rule).
