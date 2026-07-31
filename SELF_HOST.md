# External Firecrawl Deployment Guide

This repository deploys only the Firecrawl Gateway. The Firecrawl API and PostgreSQL database must be hosted and operated separately.

## Services

- `gateway`: this repository's gateway and admin UI
- External Firecrawl instance: configured in the Admin UI under **Configure > Routing**
- Firecrawl Cloud: uses `https://api.firecrawl.dev`
- External PostgreSQL: configured with separate runtime and operator credentials in `DATABASE_URL` and `OPERATOR_DATABASE_URL`

## Configure

```bash
cp .env.example .env
```

Set at least:

```dotenv
DATABASE_URL=postgresql://runtime_user:password@postgres.example.com:5432/firecrawl_gateway
OPERATOR_DATABASE_URL=postgresql://operator_user:password@postgres.example.com:5432/firecrawl_gateway
MIGRATION_DATABASE_URL=postgresql://migration_user:password@postgres.example.com:5432/firecrawl_gateway
SESSION_SECRET=replace-with-a-long-random-secret
FIRECRAWL_KEYS_ENCRYPTION_KEY=replace-with-64-character-hex-key
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-a-strong-password
```

Configure the external self-hosted Firecrawl URL in the Admin UI after startup. It must be reachable from the gateway container; use a resolvable hostname rather than `localhost`.

## Start

Using a source build:

```bash
docker compose build
docker compose run --rm --no-deps \
  -e MIGRATION_DATABASE_URL gateway node apps/api/scripts/migrate.cjs up
docker compose up -d
```

Using the published gateway image:

```bash
docker compose -f docker-compose.prebuilt.yaml run --rm --no-deps \
  -e MIGRATION_DATABASE_URL gateway node apps/api/scripts/migrate.cjs up
docker compose -f docker-compose.prebuilt.yaml up -d
```

The gateway is available at `http://localhost:8080` by default. The admin UI is at `/admin` when authentication is enabled.

## Routing

- `self-hosted-first`: use the external self-hosted Firecrawl instance first and fall back to Cloud for eligible requests.
- `self-hosted-only`: never send requests to Cloud.
- `cloud-first`: use Cloud first and fall back to the external self-hosted Firecrawl instance when eligible.
- `cloud-only`: use Cloud exclusively; never fall back to the external self-hosted Firecrawl instance.

The gateway starts cloud-first. Apply database migrations explicitly before startup; the API only checks migration readiness and never applies DDL. Change the live setting in **Configure > Routing**, or override an individual request with:

```text
X-Firecrawl-Route-Mode: self-hosted-first | self-hosted-only | cloud-first | cloud-only
```

Cloud API keys are managed in the Admin UI and injected only into upstream Cloud requests.

## Troubleshooting

Check gateway status and logs:

```bash
docker compose ps
docker compose logs gateway
curl http://localhost:8080/ready
```

A readiness failure indicates the gateway cannot connect to PostgreSQL or the expected migration version has not been applied. Upstream Firecrawl connectivity is visible in gateway request audit logs and response headers.
