<!-- b-init-managed:start -->

# Agent Instructions

## Repository Purpose

This Bun-workspace Turborepo ships an independently deployable NestJS/Fastify gateway API and root-hosted React/Vite admin dashboard for Firecrawl and an externally hosted PostgreSQL; it does not host PostgreSQL. `deploy/firecrawl/docker-compose.yml` is the repository's Docker Compose stack for the self-hosted Firecrawl backend (Firecrawl Cloud stays external).

## Project Operating Guide

### Architecture and change map

- `apps/api/src/main.ts` and `apps/api/src/app.module.ts` bootstrap the long-running Node API. Gateway route handling and fallback policy belong in `apps/api/src/proxy/` and `apps/api/src/proxy/policy.ts`.
- API administration is split across `apps/api/src/auth/`, `api-keys/`, `settings/`, `audit/`, `credits/`, and `cron/`; shared runtime configuration is in `apps/api/src/common/config.ts`.
- Estimated-credit routing lives in `apps/api/src/credits/`; the optional `REDIS_URL` ledger store shares reservations across instances, otherwise key rotation is per-instance.
- PostgreSQL schema and migration history are canonical in `apps/api/prisma/schema.prisma` and `apps/api/prisma/migrations/`. Prisma manages global API keys, settings, audit logs, and rate-limit records.
- The root-hosted admin SPA lives in `apps/admin/src/`; follow `docs/DESIGN.md` for its design standard. Admin API requests remain under `/admin/api/*` on the API origin.
- The API runs as a Node server (`bun run start` in `apps/api`) and the admin builds to a static SPA in `apps/admin/dist`; no hosting-platform config is kept in the repository. Consult `RELEASING.md` for release and deployment checks.

### Canonical sources and required flows

- Root `package.json` and `turbo.json` own workspace scripts and task orchestration; the only workspace glob is `apps/*`. Edit source rather than generated Prisma clients or build outputs (`dist/`). A new environment variable must also be added to `turbo.json` `globalPassThroughEnv` and `.env.example`.
- The `.husky/pre-commit` hook runs `lint-staged` (Prettier on all supported files, ESLint on staged API/admin sources).
- Keep configuration examples in `.env.example`; runtime configuration is validated by `apps/api/src/common/config.ts`.
- After changing Prisma schema, generate the client with `bun run db:generate`. Apply migrations with `bun run db:migrate` only as an approved operational cutover; migrations are not applied during API startup.
- API behavior and setup guidance belongs in `README.md`, `QUICKSTART.md`, `SELF_HOST.md`, and `apps/api/README.md`; dashboard UI guidance belongs in `docs/DESIGN.md`.

### Project-specific boundaries

- Firecrawl Cloud and PostgreSQL are external deployment prerequisites; the self-hosted Firecrawl comes from `deploy/firecrawl`. API and admin deploy independently; a passing GitHub Actions typecheck (`.github/workflows/deploy.yml`) is not deployment evidence.
- The post-baseline single-admin migration deletes existing users, virtual API keys, and audit logs before removing user ownership. It needs a migration-capable direct PostgreSQL connection; see `RELEASING.md` before an approved migration.
- The API forwards request bodies as UTF-8, so it is intended for UTF-8 JSON rather than binary or Latin-1 payloads. Audit logs are stored only in PostgreSQL.
- Routing modes and Cloud requirements are decided in `apps/api/src/proxy/policy.ts`; sensitive headers, cookies, and private target URLs restrict fallback.

## Verification

Run applicable root checks (automated tests exist only in `apps/api`; `apps/admin` has no `test` script, so UI changes rely on typecheck, build, and lint):

```bash
bun run typecheck
bun run build
bun run lint
bun run test
bun run format:check
```

<!-- b-init-managed:end -->
