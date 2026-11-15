# Changelog

All notable repository changes are documented here. This file follows the structure of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Only changes evidenced in the repository are listed; no release or adoption claim is made for the entries below.

## [Unreleased]

### Added

- Contributor, security, conduct, support, issue-reporting, and pull-request guidance.
- A release checklist covering versioning, tags, GitHub releases, deployment verification, and migration boundaries.
- Pull-request CI now pins Node.js 22 and validates `deploy/gateway` and `deploy/firecrawl` with `docker compose config`.
- Tests for the per-IP limiter through the real application, the proxy path guard, the admin input guards, the authentication guard, and the cron and health controllers.

### Changed

- The gateway's PostgreSQL now runs as the `postgres` service of `deploy/gateway/docker-compose.yml` (data in the `postgres_data` volume, not published on the host) instead of an external database. The compose file builds `DATABASE_URL` from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`; the deploy verification step also requires `postgres` to be running. Existing deployments must set `POSTGRES_PASSWORD` in the server `.env` and restore their data into the new container before deploying.
- The GHCR deployment workflow also deploys the `deploy/firecrawl` stack when the optional `FIRECRAWL_ENV_FILE` secret is set.
- Added a GHCR deployment flow: a root `Dockerfile` (`api` and `web` targets), `deploy/gateway/` (compose file, nginx config, `.env.example`), and `.github/workflows/docker-publish.yml` that builds, pushes to GHCR, and deploys over SSH with `prisma migrate deploy` on each deploy and a `maintenance` service replacing the external cron.
- Removed all Vercel deployment support: both `vercel.json` files, the `api/index.js` serverless entry, the default `handler` export from `apps/api/src/main.ts` (the API now listens only when run directly), and Vercel documentation. The API runs as a Node server, the admin builds to a static SPA, and the daily `GET /api/cron/maintenance` call is no longer made by the platform (see the GHCR deployment entry below).
- The self-hosted Firecrawl backend is the repository's own `deploy/firecrawl` Docker Compose stack, called directly at `FIRECRAWL_SELF_HOSTED_URL` (default `http://127.0.0.1:3002`) instead of an admin-configured external URL. The `self_hosted_firecrawl_url` setting is removed from the admin UI and settings API.
- Refreshed the canonical agent guidance and Claude redirect.
- Replaced the retired deployment workflow with CI (typecheck, lint, format check, test, build) for pull requests and pushes to `main`.
- Expanded the README with the gateway's architecture, operator use cases, routing behavior, and deployment boundaries.
- `TRUST_PROXY` now accepts `true`/`false` (also `1`/`0`, `yes`/`no`, `on`/`off`) and stops startup for any other value, such as an IP address; previously those values silently left the proxy's address in use as the client address.
- Private-target detection (which keeps a request off Firecrawl Cloud) now also treats single-label hosts such as `http://grafana/`, `100.64.0.0/10` and `::` as private.
- The session cookie's default `Secure` flag reads `NODE_ENV` through the validated configuration instead of directly from the process environment.
- Toolchain: TypeScript `~6.0.2`, ESLint `^10.3.0` and `@types/node` `^22` are aligned across `apps/api` and `apps/admin`; the unused `bcrypt` dependency is removed; the `web` image moves to `nginx/nginx-unprivileged:1.30-alpine`; and the GitHub Actions workflows use `actions/checkout@v7`, `docker/setup-buildx-action@v4`, `docker/login-action@v4`, `docker/metadata-action@v6` and `docker/build-push-action@v7`. None of the workflow or image changes has run in CI yet.
- `schema.prisma` now matches the applied migrations (`timestamptz` columns and the `idx_*` index names); no migration or database change is involved.
- Documentation states that the deploy workflow applies pending Prisma migrations on every deploy of `main`, and corrects the CI, release, quick-start and design-source descriptions to match the repository.

### Fixed

- The per-IP rate limit was never enforced: it ran as Nest middleware, where the Fastify reply it relied on does not exist, so no request was ever answered with `429` and the exempt paths never matched. It is now a Fastify `onRequest` hook, so requests over 300 per minute per IP get `429` with the `X-RateLimit-*` headers, and `/health`, `/ready` and `/admin/api/metrics` are exempt. Deployments behind a reverse proxy must set `TRUST_PROXY=true` or every client shares one limit.
- `/v1/*`, `/v2/*` and the playground forwarded paths containing `..`, `.`, backslashes or encoded dots and separators upstream, which could reach other upstream routes. They are now rejected with `400`.
- Admin endpoints no longer answer `500` for a login request with no body, an API-key create with no body or a name over 255 characters, or a repeated query parameter on the stats and usage endpoints. A stored Firecrawl key list that cannot be decrypted no longer fails `GET /admin/api/settings`; it is omitted with a warning.
- A monthly-quota unit test used a fixed reset date that went stale and now follows the current month.
