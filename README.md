# Firecrawl Gateway

A production-oriented NestJS/Fastify gateway and React admin dashboard for routing requests between an externally hosted Firecrawl instance and Firecrawl Cloud.

This repository ships the gateway, dashboard, and worker. It does **not** host Firecrawl, PostgreSQL, Redis, or any other Firecrawl runtime service.

## Highlights

- Routes supported Firecrawl API traffic between self-hosted and Cloud providers.
- Supports cloud-first, self-hosted-first, provider-specific, and per-request routing policies.
- Applies bearer-token authentication, scopes, quotas, fallback rules, and filtered-header enforcement.
- Provides tenant-scoped endpoint URLs and gateway-owned async job lifecycles.
- Includes an authenticated admin dashboard for routing, users, virtual API keys, credentials, request history, and operational settings.
- Runs API and worker processes separately, with PostgreSQL-backed persistence and explicit migration/security steps.

## Architecture

```text
Client
  |
  v
Firecrawl Gateway ──────> External Firecrawl instance
        |
        └───────────────> Firecrawl Cloud

        ├── API
        ├── Worker
        ├── React admin dashboard
        └── PostgreSQL (externally managed)
```

The gateway owns the public routing, authentication, policy, quota, audit, and admin boundaries. Upstream Firecrawl services and the database remain deployment prerequisites.

## Repository layout

| Path | Purpose |
| --- | --- |
| `apps/api/` | NestJS/Fastify gateway API and worker entrypoints |
| `apps/web/` | React/Vite admin dashboard |
| `packages/contracts/` | Shared TypeScript and Zod contracts |
| `apps/api/prisma/` | Database schema, migrations, and PostgreSQL security definitions |
| `deploy/` | Docker image and container entrypoint |
| `docs/` | Architecture, security, design, and operations documentation |
| `SELF_HOST.md` | Deployment and environment-variable reference |

## Requirements

- Node.js `>=22.22.0`
- npm 11
- Docker Compose for containerized deployment
- An externally managed PostgreSQL database with separate runtime, operator, and migration credentials
- A reachable external Firecrawl API and/or Firecrawl Cloud configuration

## Quick start

Create local configuration and review the required values:

```bash
cp .env.example .env
```

Configure the database credentials and required local or production secrets in `.env`. Then start the gateway stack:

```bash
docker compose up -d --build
```

Compose runs the one-shot migration service before starting the API and worker.

Default endpoints:

- Gateway API: `http://localhost:8080`
- Health check: `http://localhost:8080/health`
- Readiness check: `http://localhost:8080/ready`
- Admin dashboard: `http://localhost:8080/admin` when `AUTH_ENABLED=true`

For complete setup, database bootstrap, security, and troubleshooting guidance, see [`SELF_HOST.md`](SELF_HOST.md).

## Deployment

Build and run from the current checkout:

```bash
docker compose up -d --build
```

To run a prebuilt release image, set `GATEWAY_IMAGE` to an immutable `@sha256:` digest and use:

```bash
docker compose -f docker-compose.prebuilt.yaml up -d
```

The API and worker must receive runtime credentials only. Migration and security operations use the deployment-only migration credential. Existing databases require the reviewed preflight and baseline procedure described in [`docs/operations/database-bootstrap.md`](docs/operations/database-bootstrap.md).

## Local development

Install dependencies and run focused checks with:

```bash
npm ci
npm run api:typecheck
npm run api:test
npm run api:build
npm run web:typecheck
npm run web:lint
npm run web:build
```

Root scripts are orchestrated by Turborepo:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

See [`apps/api/README.md`](apps/api/README.md) for gateway routes, routing policy, tenant endpoints, and API development details.

## Routing

The gateway starts in `cloud-first` mode. The saved default can be changed in the admin dashboard under **Configure > Routing**, or overridden for an individual request with:

```text
X-Firecrawl-Route-Mode: self-hosted-first | self-hosted-only | cloud-first | cloud-only
```

Tenant data-plane requests use an endpoint ID and gateway token:

```text
https://gateway.example/e/<endpointId>/v2/scrape
Authorization: Bearer fc_<gateway-token>
```

Gateway tokens are stored as hashes and returned only when created. Async job IDs returned by tenant routes are gateway-owned and must be used for subsequent lifecycle requests.

## Security notes

- Keep `.env` and all credential-bearing files out of source control.
- Use HTTPS and stable, high-entropy production secrets.
- Keep runtime, operator, and migration database credentials separate.
- Run migrations and PostgreSQL security setup through the documented deployment workflow; API startup never applies DDL.
- Review [`docs/AUTH_SECURITY.md`](docs/AUTH_SECURITY.md) and [`docs/security/threat-model.md`](docs/security/threat-model.md) before production deployment.

## Documentation

- [`SELF_HOST.md`](SELF_HOST.md) — deployment, configuration, operations, and troubleshooting
- [`apps/api/README.md`](apps/api/README.md) — routes, gateway policy, and API development
- [`docs/operations/database-bootstrap.md`](docs/operations/database-bootstrap.md) — fresh and existing database procedures
- [`docs/AUTH_SECURITY.md`](docs/AUTH_SECURITY.md) — authentication, MFA, sessions, and email security
- [`docs/architecture/ADR-006-prisma-layered-backend.md`](docs/architecture/ADR-006-prisma-layered-backend.md) — persistence architecture
