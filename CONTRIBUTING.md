# Contributing to Harbour

Working name "Harbour": a landed-cost and import workspace for UK micro-importers. The
engineering brief in `docs/engineering-brief.md` is the specification; the ADRs in `docs/adr/`
record how ambiguous parts of it were resolved. Read both before touching the engine or the
schema.

## Prerequisites

- Node 22 (see `engines` in `package.json`); pnpm 10 via Corepack (`corepack enable`).
- Postgres 16 and Redis 7 for `packages/db` and `apps/worker` tests. Docker is the easiest
  route: `docker run -e POSTGRES_PASSWORD=harbour -p 5432:5432 postgres:16-alpine` and
  `docker run -p 6379:6379 redis:7-alpine`.
- Copy `.env.example` to `.env` where a package provides one. `.env` files are git-ignored;
  never commit one.

## Running things

| Task                              | Command                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| Install                           | `pnpm install`                                                          |
| Generate the Prisma client        | `pnpm db:generate`                                                      |
| Apply migrations locally          | `pnpm db:migrate` (runs `prisma migrate deploy`)                        |
| Create a new migration            | `pnpm --filter @harbour/db run migrate:dev --name <name>`               |
| Dev server (web)                  | `pnpm dev`                                                              |
| All tests                         | `pnpm test`                                                             |
| One package's tests               | `pnpm --filter @harbour/engine run test`                                |
| Lint / format / typecheck         | `pnpm lint`, `pnpm format`, `pnpm typecheck`                            |
| Everything CI runs                | `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test`         |
| Regenerate engine golden fixtures | `pnpm --filter @harbour/engine run fixtures:update` — see warning below |

### Golden fixtures warning

`fixtures:update` rewrites the `expected` block of every file in
`packages/engine/fixtures/quotes/` from the current engine output. It does not tell you whether
the new numbers are _right_. Before committing a golden diff:

1. Read every changed number and explain it in the PR description.
2. Get the diff reviewed by someone who has done customs entries (brief §5.10, decision #4).
3. Bump `CALC_VERSION` in `packages/engine/src/version.ts` if any money output changed
   (MAJOR) or only warnings/metadata changed (MINOR). Old quotes keep their version.

A PR that updates fixtures without a `CALC_VERSION` bump and a review note is rejected.

## Branches and reviews

- `main` is protected: changes arrive by pull request with at least one approving review and
  green CI (`checks`, `audit`, `gitleaks`). No direct pushes, no force pushes. Signed commits
  are encouraged.
- Paths in `.github/CODEOWNERS` (`packages/engine/`, `packages/db/prisma/`) require **two**
  reviewers.
- Branch names: `feat/<short-topic>`, `fix/<short-topic>`, `chore/<short-topic>`.
- Keep PRs small and single-purpose. Fill in the PR template; the definition-of-done boxes
  are not decorative.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`.

- Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `build`, `perf`.
- Scopes: `engine`, `db`, `adapters`, `web`, `worker`, `infra`, `docs`.
- A formula change is `feat(engine)!:` or `fix(engine)!:` with a `BREAKING CHANGE:` footer
  naming the new `CALC_VERSION`.

Example: `fix(engine): allocate insurance by goods-value share (calcVersion 1.1)`.

## Database and migration rules (brief §4)

1. Every migration is reviewed by two people (enforced through CODEOWNERS).
2. `prisma migrate dev` is for local development only. **Never** run `prisma db push`
   against any shared environment. CI and deploys use `prisma migrate deploy`.
3. Destructive migrations (drop column/table, type narrowing, data rewrites) require a
   backup snapshot ID in the PR template and a rollback note.
4. Enums are additive only. Never rename or remove a value in place; add the new value,
   migrate data, and leave the old value in place (mark it deprecated in a comment).
5. A migration that adds a tenant table adds its RLS policy in the same migration, and the
   same PR adds the model to the tenancy allow-list and to the cross-tenant negative tests
   (ADR-0009).
6. Migrations are plain SQL under `packages/db/prisma/migrations/` and are never edited after
   they have been applied anywhere but a laptop. Write a new one.

## Money and tenancy rules

- Money is `Decimal` in Prisma and `decimal.js` in code; it crosses boundaries as decimal
  strings (ADR-0003). The `harbour/no-number-money` lint rule and the engine's `D()` helper
  both reject `number`.
- Every tenant query goes through the tenancy client. Any new loader/action gets a
  cross-tenant negative test in the same PR (ADR-0009).
- No raw SQL without a review comment explaining why Prisma could not express it.

## Secrets

- Secrets live in the platform secret manager. Nothing under `.env`, `*.tfvars` or
  `infra/` holds a real credential.
- `gitleaks` runs in CI and should run in pre-commit locally:
  `gitleaks protect --staged --config .gitleaks.toml`.
- Sandbox keys only outside production (Stripe test mode, SeaRates sandbox, forwarder
  sandbox).

## Definition of done (brief §9)

Every PR, before requesting review:

- [ ] zod schema for every new input/output
- [ ] `organizationId` scoping present and covered by a cross-tenant negative test
- [ ] Money as `Decimal`; lint passes
- [ ] Unit tests for engine changes + golden fixtures updated; `calcVersion` bumped if formula changed
- [ ] Audit log entry for any state-changing action on quotes, docs, org settings
- [ ] No secrets, no PII in logs (checked via log snapshot test)
- [ ] Migration reviewed; rollback noted
- [ ] Feature flag for anything user-visible in Phase 2

## Decisions and ADRs

If you find yourself choosing between two readings of the brief, write an ADR
(`docs/adr/README.md` has the template) and add a row to `docs/decisions-needed.md` if the
choice needs the founder or the customs practitioner to confirm it.
