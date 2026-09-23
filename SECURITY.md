# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to `<security contact email placeholder>`.
Do not open a public issue. Include steps to reproduce, the affected component
(`apps/web`, `apps/worker`, `packages/*`, `infra/`) and any proof of concept. Please do not
access, modify or exfiltrate data belonging to any organisation other than a test account you
own.

We aim to acknowledge reports within two working days, give an initial assessment within five,
and keep you informed until the issue is resolved. We will credit reporters who wish to be
credited once a fix has shipped. There is no bug bounty at this stage.

If a report involves personal data of Harbour users, our incident process
(`docs/runbooks/security-incident.md`) applies, including notification of affected
organisations within 72 hours.

## Supported versions

Harbour is a continuously deployed service, not a distributed package. Only the version
deployed from `main` is supported; there are no maintained release branches. Security fixes
are deployed ahead of other changes.

| Component                   | Supported                            |
| --------------------------- | ------------------------------------ |
| `main` (deployed service)   | Yes                                  |
| Preview/staging deployments | Best effort; may run unreleased code |
| Forks or self-hosted copies | No                                   |

## Security controls (engineering brief §7)

A summary of what is designed in; the brief and the ADRs are the source of truth.

| Area                            | Controls                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication (§7.1)           | Magic link (15-minute, single-use, hashed) and WebAuthn passkeys; no passwords. Redis sessions, 30-day sliding expiry, rotated on privilege change. Optional TOTP, required for OWNER/ADMIN before booking. `HttpOnly; Secure; SameSite=Lax` cookies; CSRF token on every mutating form. Rate limits: 5 link requests/hour/email, 20/hour/IP.       |
| Tenancy and RBAC (§7.2)         | `currentOrg` resolved from session + membership only. Prisma tenancy extension injects `organizationId`; Postgres row-level security with a transaction-local `app.current_org`; single `can(role, action)` helper; cross-tenant negative tests in CI. No admin bypass in the customer app (ADR-0009).                                              |
| Data protection (§7.3)          | EORI, VAT numbers and document contents encrypted at rest with envelope encryption (KMS key, per-org data keys). TLS 1.2+, HSTS preload. PII minimisation; logs carry IDs only. GDPR export and deletion (soft delete → hard delete after 30 days). Daily encrypted backups, 30-day retention, quarterly restore drill. UK/EU hosting only.         |
| File uploads (§7.4)             | Presigned PUT with enforced content type and 25 MB limit; sha256, malware scan and magic-byte check before a document is `CLEAN`; presigned GET (5-minute expiry) after authorisation; private bucket with no public access (`infra/terraform/storage.tf`); sanitised names, keys `orgId/shipmentId/docId`.                                         |
| Input/output (§7.5)             | zod on every boundary including third-party responses; Prisma parameterised queries only; React output encoding, no `dangerouslySetInnerHTML`; CSP `default-src 'self'` with script nonce and `frame-ancestors 'none'`; Redis token-bucket rate limits; Turnstile on the public calculator.                                                         |
| Secrets and supply chain (§7.6) | Secrets only in the platform secret manager; separate credentials per environment; `gitleaks` in pre-commit and CI; Renovate weekly; `pnpm audit --audit-level=high --prod` fails CI; lockfile committed and `--frozen-lockfile --ignore-scripts` in CI; images pinned by digest, distroless, non-root; branch protection with review and green CI. |
| Compliance (§7.7)               | Phase 2 only: sanctions screening before booking, restricted HS chapters blocked (`RESTRICTED_GOODS`), forwarder acts as customs agent, booking kill switch.                                                                                                                                                                                        |
| Monitoring (§7.8)               | Sentry with PII scrubbing; OpenTelemetry traces and structured JSON logs with request IDs; alerts on error rate, latency, job failures, open circuit breakers, DLQ depth, failed-login and presigned-URL spikes; runbooks in `docs/runbooks/`.                                                                                                      |
| Money and customs safety        | No default duty rates; ambiguous tariff → `INDICATIVE`; `Decimal` everywhere; `calcVersion` on every quote; accepted quotes immutable via database trigger (ADR-0003, ADR-0006).                                                                                                                                                                    |

## Out of scope

- Denial of service against the public calculator beyond the documented rate limits.
- Findings in third-party services (Stripe, Cloudflare, the UK Trade Tariff API, HMRC) —
  please report those to the provider.
- Social engineering of Harbour staff or customers.
