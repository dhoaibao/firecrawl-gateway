# Database bootstrap

The API never applies DDL at startup. Prisma migrations create the relational
schema; PostgreSQL-specific roles, grants, RLS policies, triggers, and partial
indexes are applied by `apps/api/prisma/security.sql`.

## Roles

Use separate non-superuser application logins:

```sql
GRANT firecrawl_gateway_runtime TO runtime_user;
GRANT firecrawl_gateway_operator TO operator_user;
```

`DATABASE_URL` must use the runtime login. `OPERATOR_DATABASE_URL` must use a
separate login that can assume `firecrawl_gateway_operator`. The bootstrap
credential must not be used by the API.

## Fresh database setup

`MIGRATION_DATABASE_URL` is a deployment-only bootstrap credential. It must be
used for the one-off schema and security steps, never by the API process:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:deploy --workspace @firecrawl/api
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:security --workspace @firecrawl/api
```

Then configure `DATABASE_URL` and `OPERATOR_DATABASE_URL` and start the API.
Verify `/ready`; startup checks the complete Prisma schema, RLS policies,
required indexes, grants, and runtime/operator role privileges.

`db:push` remains available for disposable local databases only. Production
rollouts use the checked-in Prisma baseline and `db:deploy`.

## Existing database baseline

For a database created by the former node-pg-migrate deployment, take a
verified, restorable backup first. Then run the preflight with the deployment
credential. It confirms the backup, checks counts, duplicates, orphaned rows,
invalid user statuses, and emits the Prisma schema diff:

```bash
MIGRATION_BACKUP_CONFIRMED=true npm run migrate:preflight --workspace @firecrawl/api > /tmp/firecrawl-gateway-preflight.log
# migrate:preflight exits 2 when schema differences are found; review the file before continuing.
```

Review and remove the temporary preflight output after inspection; never
pipe it into `db execute`. The historical `pgmigrations` table and PostgreSQL security
objects are intentionally outside the Prisma baseline and must not be dropped.
Only when every Prisma-owned table, column, foreign key, and required index
matches the checked-in baseline, mark it applied and install the PostgreSQL
security layer:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:baseline --workspace @firecrawl/api
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:security --workspace @firecrawl/api
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:status --workspace @firecrawl/api
```

Do not run `db:baseline` against an empty or schema-drifting database. Resolve
any data/schema differences with a reviewed migration before proceeding.

## Security invariants

- Runtime and operator credentials are distinct.
- Runtime roles are non-superusers without `BYPASSRLS`.
- Tenant transactions set `app.account_id` locally.
- Operator transactions assume `firecrawl_gateway_operator` explicitly.
- RLS remains enabled and forced on tenant-owned tables.
- The API does not infer or create roles during normal startup.

## Native validation evidence

A disposable PostgreSQL 16 instance was validated with the documented sequence:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:deploy --workspace @firecrawl/api
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:security --workspace @firecrawl/api
```

The verification created separate non-superuser, `NOINHERIT` runtime and operator
logins, granted only their corresponding NOLOGIN roles, and confirmed:

- Prisma migrations and `security.sql` apply successfully to a fresh database.
- Required tables, forced RLS tables, policies, partial indexes, and role grants pass the native readiness assertions.
- Runtime transactions assume `firecrawl_gateway_runtime` and set `app.account_id` locally.
- Operator transactions assume `firecrawl_gateway_operator`.
- An account-scoped runtime query sees its own account and cannot see a second account; an operator query sees both.

The disposable database and generated credentials were removed after validation.
