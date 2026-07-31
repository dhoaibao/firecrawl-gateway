# Database migrations

The API does not apply DDL at startup. PostgreSQL changes are versioned in
`apps/api/migrations` and must be applied by a deployment step using a
migration credential, not `DATABASE_URL`.

## Roles

Use a migration URL with `MIGRATION_DATABASE_URL`. The migration role should
own schema changes and must not be used by the API. The runtime role should be a non-superuser without `BYPASSRLS`; the
migrations create the recommended `firecrawl_gateway_runtime`,
`firecrawl_gateway_operator`, and `firecrawl_gateway_migrator` roles when the
deployment role has permission to create them. Use separate application credentials: `DATABASE_URL` must connect as a
non-superuser runtime login, while `OPERATOR_DATABASE_URL` must connect as a
separate non-superuser login that can assume the operator role. Do not grant the
operator role to the runtime login; this keeps arbitrary runtime SQL from
switching into unrestricted tenant access:

```sql
GRANT firecrawl_gateway_runtime TO runtime_user;
GRANT firecrawl_gateway_operator TO operator_user;
```

If role creation is restricted, create these roles through the database provider
and grant the two application login roles the corresponding memberships and
privileges, including `SELECT` on `pgmigrations` for the runtime readiness
checks. Tenant selection is still passed by the trusted API as a transaction-local
context; RLS protects against missed tenant predicates, but database credentials
must remain private because RLS is not a boundary against arbitrary SQL executed
by a compromised runtime process.

## Apply

1. Confirm a tested, restorable PostgreSQL backup.
2. Set `MIGRATION_DATABASE_URL` to the migration connection and run:

   ```bash
   MIGRATION_BACKUP_CONFIRMED=true npm run migrate:preflight --workspace @firecrawl/api
   npm run migrate:status --workspace @firecrawl/api
   npm run migrate:up --workspace @firecrawl/api
   npm run migrate:status --workspace @firecrawl/api
   ```

3. Verify row counts, foreign-key/orphan checks, application readiness, login,
   existing sessions, API token authentication, API-key ownership, and audit
   history before switching `DATABASE_URL` to the runtime role.
4. Check database-provider disk headroom independently before applying. The
   preflight reports database size but cannot measure provider storage quota.

The migration is transactional by default. The account backfill uses stable
`personal:<user id>` account IDs and `ON CONFLICT`/existence checks, so a
failed deployment can be retried safely. Indexes and foreign keys are added
before ownership is enforced; do not run ad-hoc table rewrites during peak
traffic.

## Development rollback and production fixes

`migrate:down` is guarded against `NODE_ENV=production` and is intended only
for disposable development databases. Production rollback is a forward fix:
write a new ordered migration that repairs the data or schema, verify it on a
restored backup, and deploy it through the same migration step. Never remove
historical ownership, sessions, users, or audit data with a production down
migration.

## Data classification and retention

- **Identity:** email, display name, platform role, status, verification and
  authentication-version timestamps. Access is restricted to account and
  operator repositories.
- **Credentials:** password hashes and encrypted provider/API-key values.
  Hashes are not reversible; encrypted values remain deployment-key protected.
- **Target metadata:** request paths, routing outcomes, and target metadata;
  raw target URLs are sensitive and must not be exposed by new user APIs.
- **Authentication events:** login/session and future verification/reset
  events; retain only for the documented security window.
- **Audit data:** account-scoped request events with bounded retention. JSONL
  is an operational compatibility sink; PostgreSQL remains the authoritative
  tenant-filtered store.
