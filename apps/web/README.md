# @harbour/web

Phase 0 of Harbour: the public landed-cost calculator (brief §2, §11 item 5). React Router 7
framework mode, React 19, Vite 7, zod 4, TypeScript strict. No login, no persistence beyond the
Phase 0 gate metrics (`calculator.completed`, `signup.completed` log events).

```
app/
  root.tsx                    layout, <Meta/><Links/><Scripts/>, error boundary (no stacks in prod)
  entry.server.tsx            streaming SSR, isbot, per-request CSP nonce + security headers
  routes.ts                   flatRoutes() from @react-router/fs-routes
  routes/_index.tsx           landing page + email signup form
  routes/calculator.tsx       the calculator (loader: lanes/currencies/Turnstile; action: the pipeline)
  routes/signup.tsx           POST-only email signup (zod, honeypot, 5/hour/IP)
  routes/healthz.tsx          GET → { ok, calcVersion, rateSheet, … }
  components/quote-result.tsx result rendering (banner, totals, duty detail, warnings, provenance)
  data/ports.ts, countries.ts UN/LOCODE and ISO country display names
  validators/                 zod schemas: common.ts, calculator.ts, signup.ts (+ tests)
  services/
    app.server.ts             composition root (getApp()), memoised per process
    quote-pipeline.server.ts  resolveProducts → resolveFx → resolveFreight → resolveTariff → compute
    rate-limit.server.ts      token bucket: in-memory, or Redis (ioredis + Lua) when REDIS_URL is set
    turnstile.server.ts       Cloudflare Turnstile siteverify (5 s timeout, fail closed)
    logger.server.ts          JSON lines with request id and PII redaction (redact())
    db.server.ts              THE persistence seam — in-memory stores; Prisma wiring TODO lives here
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

| Variable                                      | Effect when set                                                | When unset                                                            |
| --------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`                                | reserved for the Prisma stores (`db.server.ts`)                | in-memory tariff cache, FX store, signup list                         |
| `REDIS_URL`                                   | shared token-bucket rate limiter (fails open if Redis is down) | per-process in-memory limiter                                         |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Turnstile widget + server-side verification (fail closed)      | bot check off, one warning at startup                                 |
| `FX_SEED_CSV`                                 | HMRC monthly CSV loaded into the FX store at startup           | adapters **sample** CSV, loud `fx.sample_rates` warning               |
| `RATE_SHEET_PATH`                             | freight rate sheet JSON                                        | `packages/adapters/rate-sheets/v1.json`, resolved through the package |
| `SESSION_SECRET`                              | unused in Phase 0                                              | —                                                                     |
| `NODE_ENV`, `LOG_LEVEL`                       | production hardening (HSTS), log verbosity                     | development / debug                                                   |

The client IP for rate limiting is read from `Fly-Client-IP`, `CF-Connecting-IP`, `X-Real-IP`
or the first `X-Forwarded-For` entry — deploy behind a proxy that sets one, or every visitor
shares a single bucket. The IP is hashed before it becomes a bucket key and is never logged.

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

## Phase 1 TODO (not built — brief §2, §7)

- Auth: magic link + passkeys, Redis session store, CSRF tokens on mutating forms.
- Organisations, memberships, RBAC (`can()`), tenant-scoped Prisma client + RLS (`@harbour/db`).
- Products, suppliers, HS code verification stored as `hsCodeVerifiedAt`.
- Saved quotes: persist `QuoteResult` snapshots, `ACCEPTED` immutability, hourly expiry job.
- Document vault: presigned uploads, AV scan, magic-byte checks.
- Stripe Billing subscription and plan gating.
- Worker (`apps/worker`): HMRC/ECB FX jobs, tariff cache refresh, quote expiry.
- SeaRates behind `ResilientFreightProvider` with the rate sheet as fallback and outlier checks.
