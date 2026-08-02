# Quick Start

Run the gateway with a pre-built image. Firecrawl and PostgreSQL are external services; this repository does not host them.

## Requirements

- Docker Compose
- An externally hosted Firecrawl API
- An externally hosted PostgreSQL database

## Configure and start

```bash
cp .env.example .env
# Set DATABASE_URL, OPERATOR_DATABASE_URL, MIGRATION_DATABASE_URL, and the remaining required credentials in .env
# Bootstrap the fresh database as a one-off deployment step; use db:baseline for an existing database after review.
docker compose -f docker-compose.prebuilt.yaml run --rm --no-deps \
  -e DATABASE_URL="$MIGRATION_DATABASE_URL" gateway npm run db:deploy --workspace @firecrawl/api
docker compose -f docker-compose.prebuilt.yaml run --rm --no-deps \
  -e DATABASE_URL="$MIGRATION_DATABASE_URL" gateway npm run db:security --workspace @firecrawl/api
docker compose -f docker-compose.prebuilt.yaml up -d
```

For a source build instead:

```bash
docker compose build
docker compose run --rm --no-deps \
  -e DATABASE_URL="$MIGRATION_DATABASE_URL" gateway npm run db:deploy --workspace @firecrawl/api
docker compose run --rm --no-deps \
  -e DATABASE_URL="$MIGRATION_DATABASE_URL" gateway npm run db:security --workspace @firecrawl/api
docker compose up -d
```

## Endpoints

| Service | URL |
| --- | --- |
| Gateway API | `http://localhost:8080` |
| Gateway Admin UI | `http://localhost:8080/admin` |
| Gateway readiness | `http://localhost:8080/ready` |

When authentication is enabled, log in to the Admin UI, configure the external Firecrawl URL under Configure, and create a virtual API key before sending API requests through the gateway.

## Update the image

```bash
docker compose -f docker-compose.prebuilt.yaml pull
docker compose -f docker-compose.prebuilt.yaml up -d
```
