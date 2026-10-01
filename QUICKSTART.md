# Quick Start

## Requirements

- Bun 1.3+
- Node.js 22+
- An externally hosted Firecrawl API
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

Run the admin independently with `cd apps/admin && bun run dev`, using `VITE_API_BASE_URL=http://localhost:8080`.

## Vercel deployment

Deploy `apps/api` and `apps/admin` as separate Vercel projects. Their leaf `vercel.json` files configure the NestJS function, Vite output, SPA fallback, and the authenticated daily maintenance cron at midnight UTC.

The API project needs migration-capable direct `DATABASE_URL`, `FIRECRAWL_KEYS_ENCRYPTION_KEY`, `SESSION_SECRET`, `CRON_SECRET`, `ADMIN_ORIGIN`, and `API_ORIGIN`. Set optional `REDIS_URL` to enable shared per-key estimated-credit reservations; leaving it empty selects keys locally from the last credit refresh. The admin project needs `VITE_API_BASE_URL`. Use exact origins; credentialed requests must not use `*`. The same database URL is used by runtime and migrations, so do not use a transaction-only PgBouncer endpoint; this configuration does not silently guarantee serverless connection pooling. The API function allows up to 120 seconds for streamed upstream requests, subject to the Vercel plan's maximum.

Run the Prisma migrations against the existing database before starting the API. If the API is already running, stop its dev process first, run the migration, then start the API again; Prisma does not apply migrations during startup. This applies the additive legacy `audit_logs.target_url` compatibility and repair migrations before Prisma reads audit records:

```bash
# stop the existing bun dev/API process first
bun run db:migrate
bun run dev
```

The single-admin cutover intentionally deletes all existing users, virtual API keys, and audit-log records, removes user ownership, and leaves global key/audit tables for new data. `ADMIN_EMAIL` and `ADMIN_PASSWORD` are the only admin credentials; changing them changes the credentials accepted after the API restarts. Audit logs are stored only in PostgreSQL; there is no file-based audit artifact.
