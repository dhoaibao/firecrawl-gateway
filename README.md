# Firecrawl Gateway

This repository ships an Express.js + TypeScript gateway and React admin dashboard in front of externally hosted Firecrawl services. It does not run or manage a self-hosted Firecrawl stack.

The gateway can route requests between an externally hosted Firecrawl instance and Firecrawl Cloud based on feature availability and the configured policy.

## Quick Start

```bash
cp .env.example .env
# Set DATABASE_URL, OPERATOR_DATABASE_URL, MIGRATION_DATABASE_URL, and the remaining required credentials.
# MIGRATION_DATABASE_URL is used only for one-off schema/security deployment steps.
docker compose build
docker compose run --rm --no-deps \
  -e DATABASE_URL="$MIGRATION_DATABASE_URL" gateway npm run db:deploy --workspace @firecrawl/api
docker compose run --rm --no-deps \
  -e DATABASE_URL="$MIGRATION_DATABASE_URL" gateway npm run db:security --workspace @firecrawl/api
docker compose up -d
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
- `apps/api/` — Express gateway backend
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

- [`SELF_HOST.md`](SELF_HOST.md) — deployment, configuration, and troubleshooting
- [`apps/api/README.md`](apps/api/README.md) — gateway routes, policy, and development
