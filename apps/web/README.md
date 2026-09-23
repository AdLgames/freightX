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
