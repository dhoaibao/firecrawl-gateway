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

## Deploy with GitHub Container Registry (GHCR)

Pushes to `main` run `.github/workflows/docker-publish.yml`: it builds the `api` and `web` images from the root `Dockerfile`, pushes them to `ghcr.io/<owner>/<repo>-api` and `-web` (tags `sha-<7 hex>` and `latest`), then deploys over SSH using `deploy/gateway/docker-compose.yml`. Images contain no secrets; configuration is written to the server's `.env` at deploy time.

- `gateway`: the NestJS API (Node server, `PORT` 8080, internal only).
- `web`: nginx serving the admin SPA and proxying `/admin/api`, `/v1`, `/v2`, `/health`, and `/ready` to `gateway`. One public origin serves both, so the admin needs no `VITE_API_BASE_URL` and there is no CORS: set `API_ORIGIN` and `ADMIN_ORIGIN` to the same HTTPS origin and `TRUST_PROXY=true`. It binds to `127.0.0.1:${WEB_PORT:-8080}` only.
- `maintenance`: calls `GET /api/cron/maintenance` with `CRON_SECRET` at start and every 24 hours, so no host cron is needed. The job permanently deletes audit entries older than 30 days; deletion is batched, so a large backlog drains over several runs. The 30-day window is fixed in code.
- `migrate` (profile `tools`): `prisma migrate deploy`.

**Server setup (once).** Install Docker with the Compose plugin, create a deploy user in the `docker` group with the public half of the deploy SSH key in its `authorized_keys`, and create `DEPLOY_PATH`. The workflow deploys the `deploy/firecrawl` stack itself (see below), which creates the network `firecrawl_backend`; the gateway joins it and reaches Firecrawl at `FIRECRAWL_SELF_HOSTED_URL=http://api:3002`. For a Cloud-only setup, omit `FIRECRAWL_ENV_FILE` and either run `docker network create firecrawl_backend` or set `FIRECRAWL_NETWORK` to another existing network. Put TLS in front with a host nginx and certbot. Its server block must overwrite the forwarded headers and match the gateway limits, otherwise nginx defaults (1 MiB bodies, 60 s read timeout) reject valid requests:

```nginx
server {
    listen 80;
    server_name <DOMAIN>;

    client_max_body_size 5m;        # API_MAX_BODY_BYTES default

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;        # streamed upstream responses
        proxy_read_timeout 130s;    # API_REQUEST_TIMEOUT_MS is 120 s
        proxy_send_timeout 130s;
    }
}
```

**GitHub setup (once).** Create an environment named `production` (Settings > Environments; add required reviewers if each deploy should be approved) and add these secrets to it:

| Secret               | Value                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SSH_HOST`           | Server hostname or IP                                                                                              |
| `SSH_USER`           | Deploy user, a member of the `docker` group                                                                        |
| `SSH_PORT`           | Optional, defaults to 22                                                                                           |
| `SSH_PRIVATE_KEY`    | Private key matching the deploy user's `authorized_keys`                                                           |
| `SSH_KNOWN_HOSTS`    | Output of `ssh-keyscan -p <port> <host>`; verify the fingerprint yourself                                          |
| `DEPLOY_PATH`        | Absolute directory on the server (letters, digits, `. _ / -` only)                                                 |
| `ENV_FILE`           | Full contents of the server `.env`, based on `deploy/gateway/.env.example`                                         |
| `FIRECRAWL_ENV_FILE` | Optional. Full contents of `deploy/firecrawl/.env`, based on its `.env.example`; enables the Firecrawl deploy step |

When `FIRECRAWL_ENV_FILE` is set, the workflow first uploads `deploy/firecrawl/docker-compose.yml` and that `.env` to `$DEPLOY_PATH/firecrawl` and runs `docker compose up -d --wait` there (no `pull`, so an unchanged file and `.env` is a no-op and queued Firecrawl jobs are not lost on a gateway-only deploy; changing `FIRECRAWL_VERSION` or the compose file recreates the affected services), then checks that `api`, `playwright-service`, `redis`, `rabbitmq`, and `nuq-postgres` are running. The Firecrawl API runs unauthenticated and binds to `127.0.0.1` by default; keep it that way. The workflow appends `IMAGE_PREFIX` and `IMAGE_TAG=sha-<commit>` to `ENV_FILE`, writes it as a `0600` file, logs in to GHCR with the job's short-lived `GITHUB_TOKEN` (no PAT is stored on the server), then runs `docker compose pull`, stops `maintenance`, `web`, and `gateway` (a short outage on every deploy, so nothing uses the database during a migration), runs **`prisma migrate deploy` on every deploy**, and runs `docker compose up -d --wait`. If the migration fails the services stay stopped: fix forward or redeploy an earlier tag. A final step fails the job unless `gateway`, `web`, and `maintenance` are running. Because migrations run automatically, review the post-baseline single-admin cutover in `RELEASING.md` before the first deploy: it deletes users, virtual API keys, and audit logs on a database that has not applied it yet.

**Rollback.** Run the workflow manually (Actions > docker-publish > Run workflow) with `image_tag` set to an earlier `sha-<7 hex>`. It skips the build and redeploys that image; `latest` is rejected. Migrations only move forward. A deploy for a commit that is no longer the head of `main` is skipped as stale.

**Notes.** GHCR packages are private by default; keep them private and do not flip them public. Old and untagged versions are never pruned automatically. If a `GITHUB_TOKEN` pull is denied, fall back to a classic PAT with `read:packages` stored as a secret. GitHub keeps only one pending run per concurrency group, so a delayed older deploy can occasionally replace the newest one in the queue; recover with a manual run using the newest `sha-<7 hex>`. Docker publishes bypass UFW, which is why the compose file binds to `127.0.0.1`.

Run the stack manually with `cd deploy/gateway && cp .env.example .env`, set `IMAGE_PREFIX` and `IMAGE_TAG`, `docker login ghcr.io`, then `docker compose pull && docker compose stop maintenance web gateway && docker compose --profile tools run --rm -T migrate && docker compose up -d --wait`. For local development without Docker, run `bun run build` then `bun run start` in `apps/api` and `bun run dev` in `apps/admin`.

The API remains compatible with `/health`, `/ready`, `/v1/*`, `/v2/*`, and `/admin/api/*`. Request bodies are decoded as UTF-8 before being forwarded: non-UTF-8 payloads such as binary uploads or Latin-1 text are corrupted in transit, so the gateway is intended for UTF-8 JSON traffic. Admin sessions are signed HTTP-only cookies and may need to be re-created at cutover. User-management endpoints and UI have been removed; API keys and audit records are global.

## Routing modes

- `self-hosted-first`: use the self-hosted Firecrawl (the Docker Compose stack in `deploy/firecrawl`) first and fall back to Cloud for eligible requests.
- `self-hosted-only`: never send requests to Cloud.
- `cloud-first`: use Cloud first and fall back to self-hosted when eligible.
- `cloud-only`: use Cloud exclusively.

Cloud API keys remain encrypted in PostgreSQL. Sensitive headers/cookies and private target URLs continue to disable fallback.
