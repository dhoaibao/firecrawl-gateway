# Firecrawl Gateway

Express.js + TypeScript gateway with a React admin dashboard. The gateway layer does not host Firecrawl, PostgreSQL, Redis, or any other Firecrawl runtime service.

## Stack

- **Backend**: Express.js + TypeScript
- **Admin UI**: React + Vite + Tailwind CSS
- **Build**: Multi-stage Docker (Node 22 Alpine)

## Routes

- `GET /health` — health check
- `GET /ready` — readiness check, including database connectivity
- `GET /admin` — React admin dashboard SPA when `AUTH_ENABLED=true`
- `GET /admin/api/logs` — request history JSON
- `GET /admin/api/data` — request history with totals
- `/v1/*` and `/v2/*` — proxied to the configured external Firecrawl instance or Firecrawl Cloud

## Routing Modes

The gateway starts cloud-first. Manage the live default in the Admin UI under **Configure > Routing**, or override per request with:

```text
X-Firecrawl-Route-Mode: self-hosted-first | self-hosted-only | cloud-first | cloud-only
```

Existing database settings and audit records are migrated by the ordered database migrations; startup never applies DDL. API clients must use the renamed route-mode values; the admin data endpoint exposes the self-hosted count as `totals.self_hosted`.

The external self-hosted Firecrawl URL is configured in the Admin UI. `DATABASE_URL` and `OPERATOR_DATABASE_URL` must point to separate credentials on an externally managed PostgreSQL service. Apply migrations separately with `MIGRATION_DATABASE_URL` before starting the API.

## Policy

- Core scrape/search/crawl/map/parse and open-source output formats use the external self-hosted Firecrawl instance first.
- Cloud-managed features go to Cloud: actions, agent, browser/interact, monitor, research index, support and team APIs, feedback, enterprise search options, and enhanced proxies.
- Eligible upstream failures can fall back between the external self-hosted Firecrawl instance and Cloud, subject to route mode and privacy checks.
- Fallback is disabled for `self-hosted-only`, sensitive headers/cookies, and private target URLs.

## Development

```bash
npm ci
npm run api:typecheck
npm run api:build
npm run api:test
npm run web:lint
npm run web:build
```

## Docker

```bash
docker build -f deploy/Dockerfile -t firecrawl-gateway .
```

The image builds the admin UI and gateway, then runs only the gateway process. Configure external Firecrawl and PostgreSQL endpoints at runtime.
