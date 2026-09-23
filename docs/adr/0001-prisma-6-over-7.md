# 0001. Prisma 6.19.x rather than 7/8

- **Status:** Accepted
- **Date:** 2026-09-23
- **Brief:** §3 (stack), §4 (data model)

## Context

The brief names "Postgres 16 via Prisma". At the time of writing Prisma 6.19.x is the last
release of the classic architecture: a `url` on the datasource block, the `prisma-client-js`
generator and the Rust query engine. Prisma 7 rewrote the setup around driver adapters
(`@prisma/adapter-pg`), a `prisma.config.ts` file replacing datasource URLs, and the new
`prisma-client` generator with a different output layout. Prisma 8 is still a release candidate.

Sprint 1 depends on Prisma for three things that are sensitive to churn: migrations with RLS
policies and triggers, a `$extends` tenancy client, and `Decimal` columns. The `$extends`
query-injection API is unchanged between 6 and 7, but the surrounding tooling (config file,
generator, adapter wiring, `prisma migrate` behaviour with adapters) is not, and community
material for 7 was still catching up.

## Decision

`@harbour/db` pins `prisma` and `@prisma/client` to `~6.19.3` (patch updates only):

- `datasource db { provider = "postgresql"; url = env("DATABASE_URL") }`
- `generator client { provider = "prisma-client-js"; output = "../generated/client" }`
- Rust query engine; `pnpm --filter @harbour/db run generate` downloads it from
  `binaries.prisma.sh` (CI allows this).

Renovate opens Prisma major PRs for visibility but labels them `needs-adr` and holds them on
the dependency dashboard (`renovate.json`).

## Consequences

- We stay on a version whose migration and extension behaviour is well documented and stable
  for the RLS + tenancy work in sprint 1.
- We forgo Prisma 7's smaller client bundle and driver-adapter flexibility. Nothing in Phase 0
  or 1 needs them.
- The generated client lives under `packages/db/generated/` (git-ignored) and must be generated
  in CI before typecheck.
- **Revisit** when Prisma 7 has been stable for at least six months, or earlier if a security
  fix is not back-ported to 6.x. The upgrade ADR must cover: `prisma.config.ts`, the
  `prisma-client` generator output path, `@prisma/adapter-pg` wiring, and re-running the
  cross-tenant negative tests against the new client.
