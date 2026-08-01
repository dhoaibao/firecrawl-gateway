<!-- b-init-managed:start -->
# Agent Instructions

## Repository Purpose

This repository ships an Express.js + TypeScript gateway and React admin dashboard in front of externally hosted Firecrawl services. It provides PostgreSQL-backed tenant administration, authentication security, API-key management, routing policy, and audit records; it does not host Firecrawl runtime services or PostgreSQL.

## Working Rules

- Make the smallest coherent change and verify it before claiming completion.
- Edit source files, not generated outputs; preserve unrelated working-tree changes.
- Prefer repository evidence over assumptions and do not invent commands, paths, or release steps.
- Never expose secrets, API keys, session values, customer data, or internal URLs.
- Ask before dependency changes, schema migrations, destructive commands, long-lived services, commits, or PRs.
- Keep `AGENTS.md` canonical and `CLAUDE.md` as its minimal redirect shim.

## Verification Commands

Run from the repository root:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Focused workspace checks:

```bash
npm run api:typecheck
npm run api:test
npm run web:lint
npm run web:build
```

## Codebase Map

- `apps/api/src/server.ts` and `apps/api/src/app.ts` — process lifecycle and testable Express composition.
- `apps/api/src/proxy.ts` and `apps/api/src/policy.ts` — upstream routing, API-key handling, fallback, and route-mode decisions.
- `apps/api/src/auth/` — Passport login, encrypted TOTP MFA, server session records, CSRF, opaque tokens, password policy, registration/recovery/email-change services, and the Brevo outbox/webhook adapter.
- `apps/api/src/users/`, `api-keys/`, and `settings/` — dashboard administration; serialize PostgreSQL user timestamps in `apps/api/src/users/serialization.ts` before response validation.
- `apps/api/src/db/` — PostgreSQL pools, RLS-aware transaction helpers, readiness checks, bootstrap, and schema-version enforcement. Ordered migrations are in `apps/api/migrations/`; migration/operator scripts are in `apps/api/scripts/`.
- `apps/api/src/audit-store.ts`, `middleware.ts`, `jobs/`, and `worker.ts` — audit persistence, request middleware, durable background email delivery, and shared worker lifecycle.
- `apps/web/src/` — Vite/React dashboard served under `/admin`; `pages/Account.tsx` owns account email, password, and MFA flows.
- `packages/contracts/` — shared Zod schemas and inferred control-plane types.
- `deploy/Dockerfile` and `docker-compose*.yaml` — source/prebuilt container deployment. Compose forwards auth, Brevo, and `NODE_ENV` settings.
- `docs/AUTH_SECURITY.md`, `docs/DESIGN.md`, `README.md`, `QUICKSTART.md`, and `SELF_HOST.md` — security, UI, and operator guidance.

## Safety / Do-Not-Assume

- Compose runs the gateway on container port `8080`; `GATEWAY_PORT` controls the host mapping.
- Firecrawl and PostgreSQL are external deployment prerequisites. `DATABASE_URL`, `OPERATOR_DATABASE_URL`, and deployment-only `MIGRATION_DATABASE_URL` require distinct credentials; the external Firecrawl URL is configured in the Admin UI.
- Startup never applies application DDL. Apply ordered migrations explicitly using `MIGRATION_DATABASE_URL`; the API rejects a database whose recorded migration does not match its expected schema version.
- Authentication is enabled by default. Production requires a 32+ character `SESSION_SECRET`, 64-character hex `AUTH_ENCRYPTION_KEY`, and canonical `PUBLIC_APP_URL`. `AUTH_ENCRYPTION_KEY` is distinct from Firecrawl API-key encryption and must remain stable because it encrypts TOTP secrets and outbox payloads.
- Production uses Secure `__Host-firecrawl.sid` cookies and requires HTTPS. For local HTTP only, set `NODE_ENV=development` and `SESSION_SECURE=false`; deployments terminating TLS at a proxy need the correct `TRUST_PROXY` setting.
- Admin routes require an enabled, session-asserted TOTP factor. Treat recovery codes, TOTP secrets, session IDs, authentication tokens, and Brevo credentials as secrets.
- Virtual API keys are `fc_`-prefixed, stored as hashes with encrypted key values, and their plaintext is returned only at creation. Keep `.env` and credential-bearing files out of output and commits.
- `apps/api/dist/` and `apps/web/dist/` are generated outputs. Backend Vitest files live beside source as `*.test.ts`.

## Maintainer Guide

- Node `>=22` is required. Backend TypeScript is strict; the admin UI uses Vite, Tailwind CSS, ESLint, and the design rules in `docs/DESIGN.md`.
- `npm run api:build` compiles the API only. Deploy migration sources and scripts separately from `apps/api/migrations/` and `apps/api/scripts/`.
- When adding or changing a migration, remind operators to back up the database, run `npm run migrate:preflight --workspace @firecrawl/api` for an existing database, and apply pending migrations as a one-off deployment step with `MIGRATION_DATABASE_URL` before rolling out the API. For Compose source deployments, the rollout sequence is:
  ```bash
  docker compose build
  docker compose run --rm --no-deps \
    -e MIGRATION_DATABASE_URL \
    gateway node apps/api/scripts/migrate.cjs up
  docker compose up -d
  ```
  Never add automatic DDL to API startup; verify `/ready` after the rollout.
- Configuration examples belong in `.env.example`; runtime credentials remain local. Source Compose deployments require a rebuild/recreate after source or environment wiring changes.

## Source-of-Truth Files

- `AGENTS.md` — canonical agent instructions
- `CLAUDE.md` — redirect shim only
- `.env.example` and `docker-compose*.yaml` — container environment inputs
- `package.json` and `package-lock.json` — workspace scripts and dependency graph
- `apps/api/src/config.ts` and `apps/api/src/policy.ts` — configuration defaults and routing behavior
- `apps/api/migrations/` — ordered database schema and data migrations
- `docs/AUTH_SECURITY.md` — authentication, session, MFA, and email-delivery operations
- `docs/DESIGN.md` — dashboard design rules
- `README.md`, `QUICKSTART.md`, and `SELF_HOST.md` — user-facing setup and deployment guidance
<!-- b-init-managed:end -->
