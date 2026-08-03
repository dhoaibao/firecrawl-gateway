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
# Set GATEWAY_IMAGE to an immutable sha256 digest from the release workflow.
# The one-shot migrate service applies schema and security before api/worker.
docker compose -f docker-compose.prebuilt.yaml up -d
```

For a source build instead:

```bash
docker compose up -d --build
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
# Update GATEWAY_IMAGE in .env to the new release digest before pulling.
docker compose -f docker-compose.prebuilt.yaml pull
docker compose -f docker-compose.prebuilt.yaml up -d
```
