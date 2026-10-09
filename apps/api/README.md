# API

NestJS application running on Fastify. The app exposes the existing gateway routes without the former runtime:

- `GET /health` and `GET /ready`
- `/v1/*` and `/v2/*` proxy routes
- `/admin/api/*` authentication and administration routes
- `GET /api/cron/maintenance` authenticated with `Authorization: Bearer $CRON_SECRET`

Prisma manages global PostgreSQL `api_keys`, `settings`, and `audit_logs` tables. The single admin is configured by `ADMIN_EMAIL` and `ADMIN_PASSWORD`; these credentials are not stored in PostgreSQL. The post-baseline single-admin migration intentionally deletes existing users, keys, and audit records and removes user ownership. Stop any running API process before running `bun run db:migrate` from the repository root, then start the API again. Prisma does not apply migrations during startup; the command applies the additive legacy `audit_logs.target_url` compatibility and repair migrations before Prisma reads audit records. The same migration-capable direct `DATABASE_URL` is used for runtime connections and migrations; do not use a transaction-only PgBouncer endpoint. Audit records are written only to PostgreSQL. Upstream requests time out after `API_REQUEST_TIMEOUT_MS` (120 seconds by default).
