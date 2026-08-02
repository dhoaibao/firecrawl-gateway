<!-- b-init-managed:start -->
# Agent Instructions

## Repository Purpose

This repository ships an Express.js + TypeScript gateway and React admin dashboard in front of externally hosted Firecrawl services. PostgreSQL and Firecrawl runtime services are deployment prerequisites; this repository does not host them.

## Working Rules

- Make the smallest coherent change and verify it before claiming completion.
- Edit source files, not generated `dist/` output; preserve unrelated worktree changes.
- Prefer repository evidence over assumptions; do not invent commands, paths, behavior, or release steps.
- Never expose secrets, API keys, session values, customer data, or private service details.
- Ask before dependency changes, schema migrations, destructive commands, long-lived services, commits, pushes, or PRs.
- Keep `AGENTS.md` canonical and `CLAUDE.md` as its minimal redirect shim.

## Verification Commands

Run from the repository root:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Focused checks:

```bash
npm run api:typecheck
npm run api:build
npm run api:test
npm run web:typecheck
npm run web:lint
npm run web:build
```

Database tooling, using the API workspace:

```bash
npm run prisma:validate --workspace @firecrawl/api
npm run db:status --workspace @firecrawl/api
npm run migrate:preflight --workspace @firecrawl/api
```

## Codebase Map

- `apps/api/src/server.ts` and `apps/api/src/app.ts` — process lifecycle, Express composition, health/readiness, middleware, and route mounting.
- `apps/api/src/proxy.ts` and `apps/api/src/policy.ts` — upstream routing, virtual API-key authentication, fallback, and route-mode decisions.
- `apps/api/src/infrastructure/database/` — separate runtime/operator Prisma clients, transaction context, readiness checks, and the Prisma-backed session store.
- `apps/api/src/infrastructure/http/` — async route and centralized error-handler helpers.
- `apps/api/src/auth/`, `users/`, `api-keys/`, `credentials/`, and `settings/` — authentication/security and dashboard administration domains, including routes, controllers, services, and persistence adapters.
- `apps/api/src/quota/`, `sources/`, and `jobs/` — quota accounting, infrastructure-source resolution, and gateway async-job lifecycle.
- `apps/api/src/db/`, `audit-repository.ts`, and `audit-store.ts` — compatibility database adapter/bootstrap, audit persistence, and JSONL/database audit handling.
- `apps/api/prisma/` — Prisma schema, checked-in baseline migrations, and PostgreSQL security SQL for roles, grants, RLS, triggers, and partial indexes.
- `apps/api/migrations/` — historical node-pg-migrate files retained for reference; they are not the active deployment pipeline.
- `apps/web/src/` — Vite/React admin dashboard served under `/admin`; `packages/contracts/` — shared Zod contracts and control-plane types.
- `deploy/Dockerfile` and `docker-compose*.yaml` — source/prebuilt container deployment.
- `docs/` — authentication/security, UI design, architecture, compatibility, and database-operation guidance.

## Safety / Do-Not-Assume

- Compose runs the gateway on container port `8080`; `GATEWAY_PORT` controls the host mapping.
- `DATABASE_URL` uses the runtime credential, `OPERATOR_DATABASE_URL` uses a distinct operator credential, and `MIGRATION_DATABASE_URL` is deployment-only. Never use the migration credential for the API process.
- API startup never applies DDL. Fresh databases use `db:deploy` followed by `db:security`; `db:push` is for disposable local databases only.
- Existing databases require a verified backup and reviewed `migrate:preflight` output before the explicit Prisma baseline procedure. Do not run `db:baseline` on an empty or schema-drifting database.
- Runtime and operator transactions have different tenant/RLS boundaries. Preserve separate credentials, forced RLS, operator role assumption, and readiness checks when changing persistence.
- Authentication is enabled by default. Production requires strong `SESSION_SECRET`, `AUTH_ENCRYPTION_KEY`, `PUBLIC_APP_URL`, HTTPS/Secure cookies, and stable encryption keys; treat MFA secrets, recovery codes, sessions, tokens, and Brevo credentials as secrets.
- Virtual API keys are `fc_`-prefixed, hashed, and returned in plaintext only at creation. Keep `.env` and credential-bearing files out of output and commits.
- `apps/api/dist/` and `apps/web/dist/` are generated outputs. Prisma Client is generated during API build/typecheck/lint commands.

## Maintainer Guide

- Node `>=22` is required; backend TypeScript is strict and API tests live beside source as `*.test.ts`.
- Change relational models in `apps/api/prisma/schema.prisma` and reviewed Prisma migrations. Keep PostgreSQL roles, grants, RLS, triggers, and partial-index definitions in `apps/api/prisma/security.sql`; do not add automatic DDL to API startup.
- For fresh deployment, run `db:deploy` and then `db:security` with `MIGRATION_DATABASE_URL` supplied as `DATABASE_URL`, then start/recreate the gateway and verify `/ready`.
- For an existing database, back it up, run and review `migrate:preflight`, baseline only after an exact Prisma-owned schema match, install the security layer, and check migration status. Follow `docs/operations/database-bootstrap.md` and `docs/operations/database-migrations.md`.
- Rebuild/recreate source Compose deployments after source or environment wiring changes. Configuration examples belong in `.env.example`; runtime credentials remain local.

## Source-of-Truth Files

- `AGENTS.md` — canonical agent instructions; `CLAUDE.md` — redirect shim only.
- `package.json`, workspace `package.json` files, and `package-lock.json` — scripts and dependency graph.
- `.env.example` and `docker-compose*.yaml` — deployment configuration inputs.
- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/`, and `apps/api/prisma/security.sql` — active database schema and security sources.
- `apps/api/src/config.ts`, `apps/api/src/policy.ts`, and `apps/api/src/infrastructure/database/client.ts` — configuration, routing policy, and database-boundary behavior.
- `docs/AUTH_SECURITY.md`, `docs/DESIGN.md`, `docs/architecture/ADR-006-prisma-layered-backend.md`, and `docs/operations/` — security, UI, architecture, and database-operation guidance.
- `README.md`, `QUICKSTART.md`, `SELF_HOST.md`, and `apps/api/README.md` — user-facing setup, deployment, and route/development guidance.
<!-- b-init-managed:end -->
