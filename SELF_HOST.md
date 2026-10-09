# Self-Hosting Guide

This repository deploys a gateway and ships a Docker Compose stack (`deploy/firecrawl/`) for self-hosting Firecrawl. The gateway's own PostgreSQL is not included; configure it outside this repository.

## Configure

```bash
cp .env.example .env
bun install
bun run db:generate
bun run db:migrate
```

Set migration-capable direct `DATABASE_URL`, `SESSION_SECRET`, `FIRECRAWL_KEYS_ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `CRON_SECRET`. Stop any running API process, run `bun run db:migrate`, then start the API; it applies the additive legacy `audit_logs.target_url` compatibility and repair migrations before Prisma reads audit records. The single `ADMIN_EMAIL`/`ADMIN_PASSWORD` pair is the only administrator identity and is not stored in PostgreSQL; changing it changes the credentials accepted after the API restarts. The cutover migration intentionally deletes existing users, virtual API keys, and audit-log records before making keys and audits global. The same URL is used by runtime and migrations; do not use a transaction-only PgBouncer endpoint. The gateway calls the self-hosted Firecrawl from this repository's Docker Compose stack (see below) directly, at `FIRECRAWL_SELF_HOSTED_URL` (default `http://127.0.0.1:3002`); there is no admin setting for it.

## Self-hosted Firecrawl (Docker Compose, 4 GB / single user)

This is the self-hosted backend the gateway routes to: `deploy/firecrawl/docker-compose.yml` runs Firecrawl from the published `ghcr.io/firecrawl/*` images, adapted from the [upstream compose file](https://github.com/firecrawl/firecrawl/blob/main/docker-compose.yaml) and [SELF_HOST.md](https://github.com/firecrawl/firecrawl/blob/main/SELF_HOST.md). It starts `api` (workers included), `playwright-service`, `redis`, `rabbitmq`, and `nuq-postgres`. This database is Firecrawl's own queue store, separate from the gateway's PostgreSQL.

```bash
cd deploy/firecrawl
cp .env.example .env        # set POSTGRES_PASSWORD; keep FIRECRAWL_VERSION pinned
docker compose up -d
curl http://127.0.0.1:3002/v0/health/readiness
curl -X POST http://127.0.0.1:3002/v2/scrape -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

The readiness endpoint is a heartbeat only; the scrape call is the real check. The gateway needs no further configuration when it runs on the same host (the default `FIRECRAWL_SELF_HOSTED_URL=http://127.0.0.1:3002`). If the gateway runs on another host, set `FIRECRAWL_SELF_HOSTED_URL` to an address it can reach, behind an authenticating proxy, VPN, or firewall.

- Local run: `.env.example` has commented ~6 GB and ~8 GB presets (concurrency, CPU, and per-service memory ceilings). Replace the active sizing block in `.env` with one of them, then `docker compose up -d`. Leave `FIRECRAWL_BIND_ADDRESS=127.0.0.1` and point a locally run gateway at `http://127.0.0.1:3002`.
- Sizing (default, ~4 GB host): concurrency is cut to `NUQ_WORKER_COUNT=1` (scrape worker processes; upstream default 5) and `PLAYWRIGHT_MAX_CONCURRENT_PAGES=1` (upstream default 10). The harness also starts the API, queue worker, extract worker, prefetch worker, and reconciler as separate Node processes inside the `api` container, so a 2 GB (or smaller) `api` limit is not viable: measured on 2.11.489, memory peaks at 1.8 GiB and settles at about 1.7 GiB with one worker, and peaks at 3.0 GiB and settles near 2.7 GiB with four. Capping the Node heap (`--max-old-space-size` of 128 or 192) made processes crash, so it is not used. Upstream's `NUM_WORKERS_PER_QUEUE`, `MAX_CONCURRENT_JOBS`, and `BROWSER_POOL_SIZE` appear only in its compose and `.env.example`, not in `apps/api/src` (checked at v2.11.473), so they are not used here. Default memory ceilings are api 2.5 GB, playwright 768 MB, rabbitmq 384 MB, postgres 192 MB, redis 64 MB; actual use is about 2.4 GB at idle, so a 4 GB host is workable but tight and 6 GB is more comfortable. Only the `api` figures were measured (one idle-state scrape of `example.com` stayed within them); the other ceilings are estimates, and heavy pages may hit the playwright ceiling and get OOM-killed (containers restart automatically). Scrape one page at a time and tune with `docker stats`. If `curl` returns "Connection reset by peer", check `docker compose logs api` for `Killed` / exit 137 and raise `API_MEM_LIMIT`.
- Security: the API runs with `USE_DB_AUTHENTICATION=false`, so it accepts any request. It is bound to `127.0.0.1` by default; to let the gateway reach it, put an authenticating reverse proxy, VPN, or firewall in front before changing `FIRECRAWL_BIND_ADDRESS`. Postgres, Redis, and RabbitMQ are not published.
- Persistence: like upstream, no volumes are defined, so queued jobs are lost when containers are recreated.
- Versions: `FIRECRAWL_VERSION` pins the API image (the config keys above were checked against source at v2.11.162 and v2.11.473, not 2.11.489); `playwright-service` and `nuq-postgres` default to `latest` because their release tags were not verified. Upstream warns that compose contract and image release should match, so re-check the upstream compose file when bumping the version.

## Running the API and admin

Run the API as a long-running Node server (`bun run build`, then `bun run start` from `apps/api`; it listens on `PORT`, default 8080). Build the admin with `VITE_API_BASE_URL` set to the API origin (`bun run build` in `apps/admin`) and serve `apps/admin/dist` as a static SPA that falls back to `index.html` for unknown paths. Set exact `ADMIN_ORIGIN` and `API_ORIGIN` values for the API. No scheduler is bundled: call `GET /api/cron/maintenance` once a day with `Authorization: Bearer $CRON_SECRET` (for example from host cron). This daily maintenance job permanently deletes audit entries older than 30 days; deletion is batched, so a large existing backlog drains over several daily runs. The 30-day window is fixed in code and not configurable.

The API remains compatible with `/health`, `/ready`, `/v1/*`, `/v2/*`, and `/admin/api/*`. Request bodies are decoded as UTF-8 before being forwarded: non-UTF-8 payloads such as binary uploads or Latin-1 text are corrupted in transit, so the gateway is intended for UTF-8 JSON traffic. Admin sessions are signed HTTP-only cookies and may need to be re-created at cutover. User-management endpoints and UI have been removed; API keys and audit records are global.

## Routing modes

- `self-hosted-first`: use the self-hosted Firecrawl (the Docker Compose stack in `deploy/firecrawl`) first and fall back to Cloud for eligible requests.
- `self-hosted-only`: never send requests to Cloud.
- `cloud-first`: use Cloud first and fall back to self-hosted when eligible.
- `cloud-only`: use Cloud exclusively.

Cloud API keys remain encrypted in PostgreSQL. Sensitive headers/cookies and private target URLs continue to disable fallback.
