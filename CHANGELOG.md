# Changelog

All notable repository changes are documented here. This file follows the structure of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Only changes evidenced in the repository are listed; no release or adoption claim is made for the entries below.

## [Unreleased]

### Added

- Contributor, security, conduct, support, issue-reporting, and pull-request guidance.
- A release checklist covering versioning, tags, GitHub releases, deployment verification, and migration boundaries.

### Changed

- The gateway's PostgreSQL now runs as the `postgres` service of `deploy/gateway/docker-compose.yml` (data in the `postgres_data` volume, not published on the host) instead of an external database. The compose file builds `DATABASE_URL` from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`; the deploy verification step also requires `postgres` to be running. Existing deployments must set `POSTGRES_PASSWORD` in the server `.env` and restore their data into the new container before deploying.
- The GHCR deployment workflow also deploys the `deploy/firecrawl` stack when the optional `FIRECRAWL_ENV_FILE` secret is set.
- Added a GHCR deployment flow: a root `Dockerfile` (`api` and `web` targets), `deploy/gateway/` (compose file, nginx config, `.env.example`), and `.github/workflows/docker-publish.yml` that builds, pushes to GHCR, and deploys over SSH with `prisma migrate deploy` on each deploy and a `maintenance` service replacing the external cron.
- Removed all Vercel deployment support: both `vercel.json` files, the `api/index.js` serverless entry, the default `handler` export from `apps/api/src/main.ts` (the API now listens only when run directly), and Vercel documentation. The API runs as a Node server, the admin builds to a static SPA, and the daily `GET /api/cron/maintenance` call is no longer made by the platform (see the GHCR deployment entry below).
- The self-hosted Firecrawl backend is the repository's own `deploy/firecrawl` Docker Compose stack, called directly at `FIRECRAWL_SELF_HOSTED_URL` (default `http://127.0.0.1:3002`) instead of an admin-configured external URL. The `self_hosted_firecrawl_url` setting is removed from the admin UI and settings API.
- Refreshed the canonical agent guidance and Claude redirect.
- Replaced the retired deployment workflow with typecheck-only CI for pull requests and pushes to `main`.
- Expanded the README with the gateway's architecture, operator use cases, routing behavior, and deployment boundaries.
