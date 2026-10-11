# API

NestJS application running on Fastify. The app exposes the existing gateway routes without the former runtime:

- `GET /health` and `GET /ready`
- `/v1/*` and `/v2/*` proxy routes
- `/admin/api/*` authentication and administration routes
- `GET /api/cron/maintenance` authenticated with `Authorization: Bearer $CRON_SECRET`
- `POST /admin/api/api-keys` and `PATCH /admin/api/api-keys/:id` accept optional `expires_at` (future ISO timestamp, or `null` to clear) and `rate_limit_per_minute` (integer 1 to 100000, or `null` to clear), and `monthly_quota` (integer 1 to 100000000, or `null` to clear). `PATCH` takes effect on the next request. `GET /admin/api/api-keys` adds `quota_used`, the requests counted this month for keys with a quota.
- `GET /admin/api/metrics` Prometheus text exposition, authenticated with `Authorization: Bearer $METRICS_TOKEN` (at least 16 characters). It answers 404 until `METRICS_TOKEN` is set. It exposes request duration histograms (labelled by backend, status class, fallback flag, and a route from a fixed set of Firecrawl endpoint families, otherwise `other`), a rate-limit counter, self-hosted circuit breaker state, transitions and fail-fast counts, an estimate of remaining Cloud credits read from memory, and default Node process metrics. No API key ids, target URLs, or full paths are used as labels.

Prisma manages global PostgreSQL `api_keys`, `settings`, and `audit_logs` tables. The single admin is configured by `ADMIN_EMAIL` and `ADMIN_PASSWORD`; these credentials are not stored in PostgreSQL. The post-baseline single-admin migration intentionally deletes existing users, keys, and audit records and removes user ownership. Stop any running API process before running `bun run db:migrate` from the repository root, then start the API again. Prisma does not apply migrations during startup; the command applies the additive legacy `audit_logs.target_url` compatibility and repair migrations before Prisma reads audit records. The same migration-capable direct `DATABASE_URL` is used for runtime connections and migrations; do not use a transaction-only PgBouncer endpoint. Audit records are written only to PostgreSQL. Upstream requests time out after `API_REQUEST_TIMEOUT_MS` (120 seconds by default).
