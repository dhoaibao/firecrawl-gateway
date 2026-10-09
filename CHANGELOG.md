# Changelog

All notable repository changes are documented here. This file follows the structure of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Only changes evidenced in the repository are listed; no release or adoption claim is made for the entries below.

## [Unreleased]

### Added

- Contributor, security, conduct, support, issue-reporting, and pull-request guidance.
- A release checklist covering versioning, tags, GitHub releases, deployment verification, and migration boundaries.

### Changed

- Removed all Vercel deployment support: both `vercel.json` files, the `api/index.js` serverless entry, the default `handler` export from `apps/api/src/main.ts` (the API now listens only when run directly), and Vercel documentation. The API runs as a Node server, the admin builds to a static SPA, and the daily `GET /api/cron/maintenance` call now needs an external scheduler.
- The self-hosted Firecrawl backend is the repository's own `deploy/firecrawl` Docker Compose stack, called directly at `FIRECRAWL_SELF_HOSTED_URL` (default `http://127.0.0.1:3002`) instead of an admin-configured external URL. The `self_hosted_firecrawl_url` setting is removed from the admin UI and settings API.
- Refreshed the canonical agent guidance and Claude redirect.
- Replaced the retired deployment workflow with typecheck-only CI for pull requests and pushes to `main`.
- Expanded the README with the gateway's architecture, operator use cases, routing behavior, and deployment boundaries.
