<!-- b-init-managed:start -->
# Agent Instructions

## Repository Purpose

This repository ships an Express.js + TypeScript gateway and React admin dashboard in front of externally hosted Firecrawl services. It does not host Firecrawl runtime services or PostgreSQL.

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

- `apps/api/src/server.ts` — process bootstrap, listening, and shutdown
- `apps/api/src/app.ts` — testable Express application composition
- `apps/api/src/proxy.ts` — upstream proxying, API-key handling, fallback, and audit records
- `apps/api/src/policy.ts` — route-mode and Cloud-requirement decisions
- `apps/api/src/config.ts` — injected environment configuration and validation
- `apps/api/src/auth/`, `apps/api/src/users/`, `apps/api/src/api-keys/`, and `apps/api/src/settings/` — dashboard authentication and administration; user responses serialize PostgreSQL timestamps at `apps/api/src/users/serialization.ts`
- `apps/api/src/db/` — PostgreSQL pool, transaction/tenant primitives, and bootstrap; ordered migrations live in `apps/api/migrations/`
- `apps/api/src/audit-store.ts`, `middleware.ts`, `jobs/`, and `utils.ts` — audit persistence, request middleware, background jobs, and shared helpers
- `apps/web/src/` — React dashboard served under `/admin`
- `packages/contracts/` — shared control-plane Zod schemas and inferred types
- `deploy/Dockerfile` — multi-stage admin UI and gateway image build
- `docker-compose.yaml` / `docker-compose.prebuilt.yaml` — source-build and published-image deployments
- `README.md`, `QUICKSTART.md`, `SELF_HOST.md`, and `docs/DESIGN.md` — project and admin UI guidance

## Safety / Do-Not-Assume

- Compose runs the gateway on container port `8080`; `GATEWAY_PORT` controls the host mapping.
- Firecrawl and PostgreSQL are external deployment prerequisites. The external Firecrawl URL is configured in the Admin UI; `DATABASE_URL` points to externally managed PostgreSQL.
- Startup never applies DDL. Apply ordered `apps/api/migrations/` explicitly with `MIGRATION_DATABASE_URL`; the API checks the expected migration version and fails readiness on mismatch.
- The admin UI is at `/admin` when authentication is enabled; admin endpoints are under `/admin/api/*`.
- Virtual API keys are `fc_`-prefixed, stored as hashes with encrypted key values, and their plaintext is returned only at creation. Keep `.env` and credential-bearing files out of output and commits.
- Routing defaults to `cloud-first`; supported modes and inactivity settings are stored in PostgreSQL. Sensitive headers/cookies and private target URLs restrict fallback.
- PostgreSQL timestamp columns may arrive as JavaScript `Date` values; serialize user timestamps to ISO strings before validating or returning API responses.
- `apps/api/dist/` and `apps/web/dist/` are generated outputs. Backend tests use Vitest and live beside source files as `*.test.ts`.

## Maintainer Guide

- Node `>=22` is required. Backend TypeScript is strict; the admin UI uses Vite, Tailwind CSS, and ESLint.
- `npm run api:build` compiles the API only. Migration sources and scripts are deployed separately from `apps/api/migrations/` and `apps/api/scripts/`.
- Configuration examples belong in `.env.example`; runtime credentials must remain local.

## Source-of-Truth Files

- `AGENTS.md` — canonical agent instructions
- `CLAUDE.md` — redirect shim only
- `.env.example` — configuration reference
- `package.json` and `package-lock.json` — root workspace scripts and dependency graph
- `apps/api/package.json` and `apps/web/package.json` — application scripts and dependencies
- `apps/api/src/config.ts` and `apps/api/src/policy.ts` — configuration defaults and routing behavior
- `apps/api/migrations/` — ordered database schema and data migrations
- `docs/DESIGN.md` — admin UI design rules
- `README.md`, `QUICKSTART.md`, and `SELF_HOST.md` — user-facing setup and deployment guidance
<!-- b-init-managed:end -->
