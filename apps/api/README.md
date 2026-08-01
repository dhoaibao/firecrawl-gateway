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
- `/e/:endpointId/v1/*` and `/e/:endpointId/v2/*` — tenant data-plane routes; require `Authorization: Bearer <gateway-token>` and never forward the endpoint prefix
- `/v1/*` and `/v2/*` — legacy proxied routes, retained temporarily with a `Deprecation: true` response header

## Tenant data plane

Use an account's public endpoint ID with a gateway token scoped to the requested route family:

```text
https://gateway.example/e/<endpointId>/v2/scrape
Authorization: Bearer fc_<gateway-token>
```

An endpoint ID is a public routing identifier, not a credential. The token must belong to the endpoint account; missing and cross-account endpoints receive the same opaque response. Gateway tokens are stored as hashes, returned only by the creation response, and are never redisplayed. New infrastructure sources take precedence over legacy settings during the conversion window. Run the approved one-time conversion command, `npm run sources:convert-legacy --workspace @firecrawl/api`, then explicitly validate the migrated Cloud credentials with `npm run sources:validate --workspace @firecrawl/api`; both require migration-ready database credentials and validation makes bounded external Cloud requests.

Authenticated account users manage BYOK Cloud credentials at `/admin/api/credentials`. Creating a credential immediately validates it; use `POST /admin/api/credentials/:id/validate` to revalidate it later. Credential values are accepted only on creation and are never returned.

### Async job IDs

On tenant routes, async crawl, batch scrape, scrape-job, and interact-session creation responses return a gateway-owned ID and lifecycle URL. Use that returned ID for subsequent `GET`, `DELETE`, and documented scrape-interaction requests under the same `/e/<endpointId>/v1` or `/v2` prefix; never use an upstream ID or URL. The gateway keeps the upstream mapping account-scoped and pins lifecycle calls to the source and credential that created the job. Missing, cross-account, or route-family-mismatched IDs use the same opaque response; a disabled recorded source returns an unavailable response rather than falling back to another source.

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
