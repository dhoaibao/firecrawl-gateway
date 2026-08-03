# Firecrawl Gateway

This repository ships a NestJS/Fastify + TypeScript gateway and React admin dashboard in front of externally hosted Firecrawl services. It does not run or manage a self-hosted Firecrawl stack.

The gateway can route requests between an externally hosted Firecrawl instance and Firecrawl Cloud based on feature availability and the configured policy.

## Quick Start

```bash
cp .env.example .env
# Configure the required database credentials and production secrets.
# See SELF_HOST.md for the complete required/optional environment reference.
docker compose up -d --build
# Compose runs the one-shot migrate service before api and worker.
```

Default endpoints:

- Gateway API: `http://localhost:8080`
- Admin UI: `http://localhost:8080/admin` when `AUTH_ENABLED=true`

The external Firecrawl instance and PostgreSQL database are deployment prerequisites and are not created by this repository.

## Admin Dashboard

The dashboard provides visibility into request routing, success rates, fallback behavior, latency, users, and virtual API keys.

![Admin UI Dashboard](assets/admin.png)

## What Is Included

- `docker-compose.yaml` — gateway image build and runtime
- `docker-compose.prebuilt.yaml` — gateway runtime using the published image
- `apps/api/` — NestJS/Fastify gateway backend
- `apps/web/` — React admin UI
- `packages/contracts/` — shared control-plane contracts
- `.env.example` — gateway configuration reference
- `SELF_HOST.md` — external-service deployment guide

## Architecture

```text
             Client
                |
                v
          Firecrawl Gateway
          |               |
          v               v
 External Firecrawl   Firecrawl Cloud
```

## Documentation

- [`SELF_HOST.md`](SELF_HOST.md) — complete deployment, environment-variable reference, operations, and troubleshooting
- [`apps/api/README.md`](apps/api/README.md) — gateway routes, policy, and development
- [`docs/operations/database-bootstrap.md`](docs/operations/database-bootstrap.md) — fresh and existing PostgreSQL database procedures
- [`docs/AUTH_SECURITY.md`](docs/AUTH_SECURITY.md) — authentication, MFA, session, and email security
