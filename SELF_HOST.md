# External Service Guide

This repository deploys a gateway, not Firecrawl or PostgreSQL. Configure both services outside this repository.

## Configure

```bash
cp .env.example .env
bun install
bun run db:generate
bun run db:migrate
```

Set migration-capable direct `DATABASE_URL`, `SESSION_SECRET`, `FIRECRAWL_KEYS_ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `CRON_SECRET`. Stop any running API process, run `bun run db:migrate`, then start/redeploy the API; it applies the additive legacy `audit_logs.target_url` compatibility and repair migrations before Prisma reads audit records. The single `ADMIN_EMAIL`/`ADMIN_PASSWORD` pair is the only administrator identity and is not stored in PostgreSQL; changing it changes the credentials accepted after the API restarts. The cutover migration intentionally deletes existing users, virtual API keys, and audit-log records before making keys and audits global. The same URL is used by runtime and migrations; do not use a transaction-only PgBouncer endpoint. This configuration does not silently guarantee serverless connection pooling. Configure the external self-hosted Firecrawl URL in the admin UI under **Configure > Routing**. The API function allows up to 120 seconds for streamed upstream requests, subject to the Vercel plan's maximum.

### Serverless connection pooling

Each cold serverless instance of the API opens its own PostgreSQL connection, and nothing in this repository configures Prisma connection pooling. As instance count grows, connections can exceed what the database accepts and requests begin failing with connection errors.

For serverless deployments (Vercel and similar), point the runtime at a pooled endpoint: PgBouncer sitting between Prisma Client and the database, a provider pooler (for example Supabase or Neon's pooled connection strings), or a managed pooler such as Prisma Postgres. Prisma Client also supports a `?pgbouncer=true` URL flag for PgBouncer in transaction mode (required for PgBouncer versions below 1.21.0) and a `connection_limit` URL parameter to size the per-instance pool.

Two constraints from this repository's setup apply:

- The same `DATABASE_URL` is used by the runtime and `bun run db:migrate`. Migrations need a direct, migration-capable connection, so a transaction-only PgBouncer endpoint is not suitable as-is; use session-mode pooling, or run migrations against the direct database URL while the runtime uses the pooled one.
- Prisma Client is instantiated once per process by the NestJS dependency-injection container and reused across warm invocations, which is the correct pattern; the remaining exposure is the per-cold-start connection, which only an external pooler addresses.

## Self-hosted Firecrawl (Docker Compose, 2 GB / single user)

`deploy/firecrawl/docker-compose.yml` runs Firecrawl from the published `ghcr.io/firecrawl/*` images, adapted from the [upstream compose file](https://github.com/firecrawl/firecrawl/blob/main/docker-compose.yaml) and [SELF_HOST.md](https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md). It starts `api` (workers included), `playwright-service`, `redis`, `rabbitmq`, and `nuq-postgres`. This database is Firecrawl's own queue store, separate from the gateway's PostgreSQL.

```bash
cd deploy/firecrawl
cp .env.example .env        # set POSTGRES_PASSWORD; keep FIRECRAWL_VERSION pinned
docker compose up -d
curl http://127.0.0.1:3002/v0/health/readiness
curl -X POST http://127.0.0.1:3002/v2/scrape -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

The readiness endpoint is a heartbeat only; the scrape call is the real check. Then set the Firecrawl URL under **Configure > Routing** in the admin UI.

- Local run: `.env.example` has commented ~4 GB and ~8 GB presets (concurrency, CPU, and per-service memory ceilings, about 2.7 GB and 5.1 GB total). Replace the active sizing block in `.env` with one of them, then `docker compose up -d`. Leave `FIRECRAWL_BIND_ADDRESS=127.0.0.1` and point a locally run gateway at `http://127.0.0.1:3002`. A gateway on Vercel cannot reach a local machine without a tunnel.
- Sizing (default, ~2 GB host): concurrency is cut to `NUQ_WORKER_COUNT=1` (scrape worker processes; upstream default 5) and `PLAYWRIGHT_MAX_CONCURRENT_PAGES=1` (upstream default 10). The harness still starts its other helper processes inside the `api` container, so the api ceiling is an estimate. Upstream's `NUM_WORKERS_PER_QUEUE`, `MAX_CONCURRENT_JOBS`, and `BROWSER_POOL_SIZE` appear only in its compose and `.env.example`, not in `apps/api/src` (checked at v2.11.473), so they are not used here. Memory ceilings are api 768 MB, playwright 512 MB, rabbitmq 256 MB, postgres 192 MB, redis 64 MB (about 1.8 GB total, leaving little for the OS). These are estimates, not upstream guidance, and heavy pages may hit the playwright or api ceiling and get OOM-killed (containers restart automatically). Add 2 GB of host swap, scrape one page at a time, and tune with `docker stats`; 4 GB is more comfortable.
- Security: the API runs with `USE_DB_AUTHENTICATION=false`, so it accepts any request. It is bound to `127.0.0.1` by default; to let the gateway reach it, put an authenticating reverse proxy, VPN, or firewall in front before changing `FIRECRAWL_BIND_ADDRESS`. Postgres, Redis, and RabbitMQ are not published.
- Persistence: like upstream, no volumes are defined, so queued jobs are lost when containers are recreated.
- Versions: `FIRECRAWL_VERSION` pins the API image (the config keys above were checked against source at v2.11.162 and v2.11.473, not 2.11.489); `playwright-service` and `nuq-postgres` default to `latest` because their release tags were not verified. Upstream warns that compose contract and image release should match, so re-check the upstream compose file when bumping the version.

## Vercel projects

Deploy `apps/api` and `apps/admin` separately. Set `VITE_API_BASE_URL` in the admin project to the API origin. Set exact `ADMIN_ORIGIN` and `API_ORIGIN` values in the API project. The API's `vercel.json` schedules `/api/cron/maintenance`; Vercel authenticates it with `CRON_SECRET`. This daily maintenance cron permanently deletes audit entries older than 30 days; deletion is batched, so a large existing backlog drains over several daily runs. The 30-day window is fixed in code and not configurable.

The API remains compatible with `/health`, `/ready`, `/v1/*`, `/v2/*`, and `/admin/api/*`. Request bodies are decoded as UTF-8 before being forwarded: non-UTF-8 payloads such as binary uploads or Latin-1 text are corrupted in transit, so the gateway is intended for UTF-8 JSON traffic. Admin sessions are signed HTTP-only cookies and may need to be re-created at cutover. User-management endpoints and UI have been removed; API keys and audit records are global.

## Routing modes

- `self-hosted-first`: use the external self-hosted Firecrawl instance first and fall back to Cloud for eligible requests.
- `self-hosted-only`: never send requests to Cloud.
- `cloud-first`: use Cloud first and fall back to self-hosted when eligible.
- `cloud-only`: use Cloud exclusively.

Cloud API keys remain encrypted in PostgreSQL. Sensitive headers/cookies and private target URLs continue to disable fallback.
