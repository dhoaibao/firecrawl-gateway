# Quick Start

## Requirements

- Bun 1.3+
- Node.js 22+
- Docker with Compose, to run the self-hosted Firecrawl from `deploy/firecrawl` (see [`SELF_HOST.md`](SELF_HOST.md)); optional if you only use Firecrawl Cloud
- An externally hosted PostgreSQL database

## Local development

```bash
bun install
cp .env.example .env
# Set migration-capable direct DATABASE_URL, encryption/session secrets, and the single admin credentials.
bun run db:generate
bun run db:migrate
bun run dev
```

To use the self-hosted backend, start it with `cd deploy/firecrawl && cp .env.example .env && docker compose up -d`. The gateway reaches it at `http://127.0.0.1:3002` by default (`FIRECRAWL_SELF_HOSTED_URL`), with no admin configuration.

Run the admin independently with `cd apps/admin && bun run dev`, using `VITE_API_BASE_URL=http://localhost:8080`.

## Running in production

Run `apps/api` as a long-running Node server: `bun run build`, then `bun run start` from `apps/api` (it listens on `PORT`, default 8080). Build `apps/admin` with `VITE_API_BASE_URL` set to the API origin and serve `apps/admin/dist` as a static SPA that falls back to `index.html`.

The API needs migration-capable direct `DATABASE_URL`, `FIRECRAWL_KEYS_ENCRYPTION_KEY`, `SESSION_SECRET`, `CRON_SECRET`, `ADMIN_ORIGIN`, and `API_ORIGIN`. Set optional `REDIS_URL` to enable shared per-key estimated-credit reservations; leaving it empty selects keys locally from the last credit refresh. Use exact origins; credentialed requests must not use `*`. The same database URL is used by runtime and migrations, so do not use a transaction-only PgBouncer endpoint. Upstream requests time out after `API_REQUEST_TIMEOUT_MS` (120 seconds by default). Call `GET /api/cron/maintenance` daily with `Authorization: Bearer $CRON_SECRET` from a scheduler such as host cron.

Run the Prisma migrations against the existing database before starting the API. If the API is already running, stop its dev process first, run the migration, then start the API again; Prisma does not apply migrations during startup. This applies the additive legacy `audit_logs.target_url` compatibility and repair migrations before Prisma reads audit records:

```bash
# stop the existing bun dev/API process first
bun run db:migrate
bun run dev
```

The single-admin cutover intentionally deletes all existing users, virtual API keys, and audit-log records, removes user ownership, and leaves global key/audit tables for new data. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are the only admin credentials; changing them changes the credentials accepted after the API restarts. Audit logs are stored only in PostgreSQL; there is no file-based audit artifact.
