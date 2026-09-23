# Phase 1 build plan

- **Started:** 2026-09-23, ahead of the Phase 0 gate at the founder's request.
- **Spec:** brief §2, §3, §7; `docs/phase-1-workspace-ux.md`.
- **Gate to Phase 2:** 20 paying organisations (brief §2).

## Milestones

| #   | Milestone                                                                                                                                                                                                 | Depends on                            | Migration                   | Status         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------- | -------------- |
| M1  | Auth and workspace shell: magic-link sign-in, Redis sessions, CSRF, organisations and memberships, `requireUser` / `requireOrg` loaders running inside `withOrgTransaction`, RBAC, navigation             | engine 1.1 and customs profile schema | `0004_auth_sessions`        | Next           | Done |
| M2  | Settings: organisation details, customs profile wizard, members and invitations, audit log view                                                                                                           | M1                                    | none expected               | Built, merging |
| M3  | Products and suppliers: catalogue list, product drawer, HS code lookup with official description                                                                                                          | M1                                    | none expected               | Done           |
| M4  | Quotes: builder with live breakdown, save as snapshot, accept (immutable), list; Home with action banner, recent drafts and quick duty check                                                              | M3                                    | none expected               | Not started    |
| M5  | Documents: presigned upload and download, type tagging, scan status, missing-files list, organisation documents                                                                                           | M1                                    | `0005_documents_quote_link` | Built, merging |
| M6  | Billing: Stripe Checkout, Billing Portal, signed webhooks, plan gating                                                                                                                                    | M1                                    | `0006_billing`              | Done           |
| M7  | Purchase orders: PO list and editor from the catalogue, issue and freeze, deposit and balance due dates from payment terms, "get freight quote" from a PO, one accepted quote per PO (ADR-0013)           | M3, M4                                | `0008_purchase_orders`      | Not started    |
| M8  | Actual costs: bills, bill lines linked to POs and PO items, payments with FX, credit notes; variance by category and actual landed cost per SKU (engine `actuals` module with golden fixtures) (ADR-0014) | M5, M7                                | `0009_bills`                | Not started    |

M2, M3, M5 and M6 run in parallel after M1. M4 follows M3. Each milestone owns its route files;
M1 owns the shared shell (`root.tsx`, navigation, session and auth services) and later
milestones add to it only through small, named extension points.

## External services

Each is behind an interface with a local fallback, so the workspace runs and tests without
accounts. Real credentials are deployment configuration.

| Service                          | Used by | Local fallback                                                     |
| -------------------------------- | ------- | ------------------------------------------------------------------ |
| Email (magic links, invitations) | M1, M2  | Console transport that logs the link in development only           |
| Redis (sessions, rate limits)    | M1      | In-memory store, single instance only                              |
| S3-compatible storage (R2)       | M5      | Local directory store with signed URLs served by the app           |
| Malware scan                     | M5      | Magic-byte and size check only, marked clearly as not a virus scan |
| Stripe                           | M6      | Tests use recorded webhook payloads and a fake client              |

## Definition of done per milestone

Brief §9 applies: zod on every input, organisation scoping with a cross-tenant negative test,
money as `Decimal`, audit entries for state changes, no PII in logs, migrations reviewed with a
rollback note.
