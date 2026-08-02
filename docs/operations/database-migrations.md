# Database migrations

The gateway uses Prisma migrations for the relational schema and a separate
idempotent PostgreSQL security script for roles, grants, RLS, triggers, and
partial indexes. The API never applies DDL at startup.

## Fresh databases

Use the checked-in baseline (or later reviewed migrations) and then apply the
security layer:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:deploy --workspace @firecrawl/api
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:security --workspace @firecrawl/api
```

## Existing databases

The former node-pg-migrate history is not silently converted. Back up the
existing database, confirm the backup is restorable, and run the preflight.
It checks duplicates, orphaned rows, invalid user statuses, and the complete
Prisma schema diff. Only an exact Prisma-owned schema match may be marked as
applied:

```bash
MIGRATION_BACKUP_CONFIRMED=true npm run migrate:preflight --workspace @firecrawl/api > /tmp/firecrawl-gateway-preflight.log
# migrate:preflight exits 2 when schema differences are found; do not baseline until reviewed.
```

If the diff is non-empty, stop and create/review a corrective Prisma migration
or data migration before baselining. Historical `pgmigrations` and the
PostgreSQL security objects are intentionally outside the Prisma baseline;
never drop them just to make the diff empty. After review, and only if the
Prisma-owned schema matches, run:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:baseline --workspace @firecrawl/api
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:security --workspace @firecrawl/api
```

Never run `db:baseline` on an empty or drifting database. Check the resulting
migration state with:

```bash
DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:status --workspace @firecrawl/api
```

The old `apps/api/migrations/` files remain only as historical reference; they
are not executed by the application or deployment scripts.
