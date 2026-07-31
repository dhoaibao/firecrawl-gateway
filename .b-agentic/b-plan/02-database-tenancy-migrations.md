# Phase 2 — Database, Migrations, and Tenant Isolation

Depends on: Phase 1
Release posture: no public registration; compatibility routes remain active

## Scope

- Replace startup `schema.sql` with ordered, reviewable migrations.
- Separate identity (`users`) from tenant ownership (`accounts`).
- Create one personal account and owner membership for every existing user.
- Add PostgreSQL roles/RLS defense in depth and account-scoped repository primitives.
- Preserve existing users, sessions, API token authentication, settings, and audit history.

## Data ownership model

```text
users
  id, normalized_email, password_hash, platform_role, status,
  email_verified_at, auth_version, timestamps

accounts
  id, public_id, display_name, status, timestamps

account_memberships
  account_id, user_id, role(owner/member), timestamps
```

All future tenant resources reference `account_id`. `users.is_admin` migrates to an explicit platform role, while tenant roles live only in memberships.

## Steps

### 1. Introduce a real migration runner

- Add an approved versioned migration tool (`node-pg-migrate` is the researched recommendation).
- Create ordered migrations and a migration-history table.
- Add `migrate:up`, `migrate:down` for development only, `migrate:create`, and `migrate:status` scripts.
- Run migrations as an explicit deployment step using `MIGRATION_DATABASE_URL` or a migration role.
- API and worker startup check expected schema version/readiness but never apply DDL.
- Convert current `schema.sql` into a baseline migration for new databases; write forward migrations for existing databases.

Done when:

- A fresh database reaches the expected schema from zero.
- A copy of the current schema upgrades without data loss.
- API startup fails readiness with a clear schema mismatch instead of changing the database.

### 2. Add database transaction primitives

- Implement `withTransaction` using one checked-out `pg` client for BEGIN/COMMIT/ROLLBACK.
- Add `withAccountTransaction(accountId, fn)` that sets transaction-local tenant context.
- Add bounded statement/lock timeouts for control-plane transactions.
- Keep SQL parameterized and repository-owned; do not introduce an ORM during the rewrite.

Done when:

- Rollback and connection-release behavior is integration-tested against PostgreSQL.
- Tenant context cannot leak through pooled connections after transaction completion.

### 3. Create accounts and memberships

- Add `accounts` and `account_memberships` with foreign keys, unique constraints, and timestamps.
- Add a non-secret, random, immutable `accounts.public_id` used by tenant endpoints; reserve custom slugs for a later feature.
- Backfill one personal account and owner membership per existing user in an idempotent data migration.
- Keep `users` IDs stable so current sessions remain deserializable.
- Normalize email uniqueness safely (for example a stored normalized email or a `lower(email)` unique index) before public registration.

Done when:

- Every current user has exactly one personal account and owner membership.
- Duplicate/mixed-case email fixtures cannot create multiple identities.
- Backfill can resume safely after interruption.

### 4. Migrate tenant ownership incrementally

- Add nullable `account_id` to current `api_keys` and `audit_logs`.
- Backfill through the user's personal account.
- Add indexes and foreign keys, validate them, then make ownership non-null where historical semantics allow.
- During transition, dual-read/dual-write `user_id` and `account_id`; remove legacy ownership only after compatibility verification.
- Do not expose raw audit target URLs through new user APIs.

Done when:

- Every active API key maps to one account.
- Existing tokens still authenticate during the transition.
- Tenant-scoped audit queries cannot return another account's rows.

### 5. Add row-level security defense in depth

- Create separate database roles for migrations and application runtime; runtime must not be superuser or `BYPASSRLS`.
- Enable and force RLS on tenant-owned tables after backfill.
- Policies use transaction-local account context for user operations.
- Operator repositories use an explicit, separately tested operator context; ordinary repositories cannot request it.
- Retain explicit `account_id` predicates in SQL even with RLS.

Done when:

- Integration tests prove default-deny with missing tenant context.
- Account A cannot select/update/delete Account B through every tenant repository.
- RLS tests run under the actual runtime role, not the table owner or superuser.
- Operator queries are separately authorized and audited.

### 6. Establish migration and retention safety

- Add migration preflight: backup requirement, current version, row counts, invalid/orphan checks, and disk headroom.
- Document forward-fix strategy; destructive down migrations are not used on production data.
- Add database constraints for status/role enums or validated text values, plus check constraints for non-negative counters introduced later.
- Define data classification for identity, credentials, target metadata, auth events, and audit data.

Done when:

- `docs/operations/database-migrations.md` describes backup, apply, verify, and forward-fix procedures.
- Schema tests verify foreign keys, uniqueness, RLS, and critical checks.

## Verification

- Fresh-database migration test.
- Current-schema upgrade fixture.
- Idempotent backfill test with interruption/retry.
- Cross-account repository isolation suite.
- Existing auth/session/token regression suite.
- Root typecheck, tests, and builds.

## Risks and rollback

- RLS can silently hide rows if context is missing. Roll out table by table after explicit predicates and tests exist.
- Table owners bypass RLS unless forced; test deployment roles directly.
- Avoid long table locks: add nullable columns/indexes first, backfill in batches, validate constraints, then enforce non-null.
- Never remove `user_id`, legacy settings, or old routes in this phase; deprecation follows production verification.
