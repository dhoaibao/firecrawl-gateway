<!-- b-init-managed:start -->
# Agent Instructions

## Repository Purpose

This repository ships a NestJS/Fastify + TypeScript Firecrawl gateway, React user/operator dashboards, and a dedicated async worker. PostgreSQL and externally hosted Firecrawl services are deployment prerequisites; this repository does not host them.

## Working Rules

- Make the smallest coherent change and verify it before claiming completion.
- Edit source files, not generated `dist/` output; preserve unrelated worktree changes.
- Prefer repository evidence over assumptions; do not invent commands, paths, behavior, or release steps.
- Never expose secrets, API keys, session values, customer data, or private service details.
- Ask before dependency changes, schema migrations, destructive commands, long-lived services, commits, pushes, or PRs.
- Keep `AGENTS.md` canonical and `CLAUDE.md` as its minimal redirect shim.
- Keep operator mutations behind platform-admin authorization, verified MFA, recent step-up, mutation reasons, audit logging, and database-readiness checks.

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

- `apps/api/src/main.ts`, `app.module.ts`, and `common/http/fastify-http.ts` — native Fastify/Nest process lifecycle, HTTP controls, health/readiness, and route composition.
- `apps/api/src/modules/gateway/` — upstream routing, virtual API-key authentication, fallback, async lifecycle pinning, filtered headers, streaming, and quota behavior.
- `apps/api/src/modules/operator/`, `accounts/`, `gateway-tokens/`, `integrations/`, `infrastructure/`, `settings/`, and `quota/` — native operator, account, token, credential, source, configuration, and quota boundaries.
- `apps/api/src/modules/auth/`, `portal/`, `webhooks/`, `email/`, `audit/`, and `static-ui/` — native authentication/session, user portal, Brevo delivery, audit retention, and static UI boundaries.
- `apps/api/src/infrastructure/database/` — separate runtime/operator Prisma clients, transaction context, readiness checks, and the Prisma-backed Fastify session store.
- `apps/api/src/core/` — configuration, database, health, rate limiting, request context, validation, and shared HTTP infrastructure.
- `apps/api/src/quota/`, `sources/`, `credentials/`, `settings/`, `users/`, and `types.ts` — retained domain/persistence helpers still used by native services.
- `apps/api/src/rate-limit-store.ts`, `audit-repository.ts`, `logger.ts`, and `db/index.ts` — retained PostgreSQL-backed quota/rate-limit/audit/database compatibility helpers used by native services.
- `apps/api/prisma/` — Prisma schema, checked-in migrations, and PostgreSQL security SQL for roles, grants, RLS, triggers, and partial indexes.
- `apps/web/src/` — Vite/React user portal and `/admin` dashboard; `apps/web/src/features/operator/` contains operator-console views and controls.
- `packages/contracts/` — shared Zod contracts and control-plane types.
- `deploy/Dockerfile`, `deploy/docker-entrypoint.sh`, and `docker-compose*.yaml` — source/prebuilt API, worker, preflight, and migration container deployment.
- `docs/` — authentication/security, UI design, architecture, compatibility, database-operation, threat-model, and rollout guidance.

## Safety / Do-Not-Assume

- Compose runs the gateway on container port `8080`; `GATEWAY_PORT` controls the host mapping. Prebuilt deployment requires an immutable `GATEWAY_IMAGE` digest.
- `DATABASE_URL` uses the runtime credential, `OPERATOR_DATABASE_URL` uses a distinct operator credential, and `MIGRATION_DATABASE_URL` is deployment-only. Only one-shot `preflight`/`migrate` containers receive the migration credential; never use it for API or worker processes.
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
- For an existing database, back it up, run and review `migrate:preflight`, baseline only after an exact Prisma-owned schema match, install the security layer, and check migration status. Follow `docs/operations/database-bootstrap.md`.
- Operator-console schema/security changes require both the checked-in Prisma migration and matching `security.sql` policy/grant updates; missing prerequisites must keep the operator boundary read-only.
- Rebuild/recreate source Compose deployments after source or environment wiring changes. Production rollout restore-tests a backup, runs preflight before forward-only migration, then verifies API health/readiness and worker heartbeat. Configuration examples belong in `.env.example`; runtime credentials remain local.

## Source-of-Truth Files

- `AGENTS.md` — canonical agent instructions; `CLAUDE.md` — redirect shim only.
- `package.json`, workspace `package.json` files, and `package-lock.json` — scripts and dependency graph.
- `.env.example`, `docker-compose*.yaml`, `deploy/docker-entrypoint.sh`, and `.github/workflows/deploy.yml` — deployment configuration, image-command, and release sources; `SELF_HOST.md` is the user-facing deployment and environment-variable guide.
- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/`, and `apps/api/prisma/security.sql` — active database schema and security sources.
- `apps/api/src/core/config/config.service.ts`, `apps/api/src/modules/gateway/application/gateway-policy.ts`, `apps/api/src/infrastructure/database/client.ts`, and `apps/api/src/modules/operator/presentation/operator.controller.ts` — configuration, routing policy, database-boundary behavior, and operator authorization/readiness behavior.
- `apps/web/src/App.tsx`, `apps/web/src/components/Sidebar.tsx`, and `apps/web/src/features/operator/OperatorPage.tsx` — dashboard routing, navigation, and operator-console UI behavior.
- `docs/AUTH_SECURITY.md`, `docs/DESIGN.md`, `docs/security/threat-model.md`, `docs/architecture/ADR-006-prisma-layered-backend.md`, and `docs/operations/` — security, UI, architecture, database-operation, and production-rollout guidance.
- `README.md`, `SELF_HOST.md`, and `apps/api/README.md` — user-facing setup, deployment/environment reference, and route/development guidance.
<!-- b-init-managed:end -->
