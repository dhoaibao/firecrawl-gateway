# Hardening and production rollout

Production registration remains disabled until the checks in this document are
signed off (`REGISTRATION_ENABLED=false`). The API and worker use the runtime
and operator credentials; only the one-shot `migrate` process receives
`MIGRATION_DATABASE_URL`.

## Deployment gate

The repository workflow publishes an immutable digest and uses the approved
SSH deployment environment's pre-provisioned `.env` secret mechanism. It takes
a custom-format PostgreSQL backup, runs migration preflight, applies forward
migrations, deploys API/worker, checks health/readiness, and can rehearse a
previous-image rollback before restoring the new digest. Credentials are never
reconstructed through an interpolated remote shell heredoc.

1. Take and restore-test a PostgreSQL backup in an ephemeral PostgreSQL
   container.
2. Run the immutable image's read-only `preflight` command for an existing
   database and review its output. Pending release migrations are expected;
   failed migrations, unknown migration history, and Prisma-reported schema
   drift are blockers.
3. Run the immutable image's `migrate` command once. It applies Prisma
   migrations and `prisma/security.sql`; it never runs as the API process.
4. Start API and worker processes with feature flags closed and wait for
   `/health`, `/ready`, and the worker heartbeat health check to become healthy.
5. Run typecheck, lint, unit/integration tests, build, image scan, and dependency
   review. No CI check may use a developer database or a real provider.
6. Exercise rollback by deploying the previous image and applying a forward fix;
   do not roll back database schema destructively.

The Compose topology encodes the migration dependency and runs API/worker with a
read-only root filesystem, dropped Linux capabilities, and a writable `/tmp`
only. PostgreSQL is the canonical audit store. JSONL output is retained only as
an explicit local compatibility option and is disabled by the production server.
Request-audit retention defaults to 90 days (`AUDIT_RETENTION_DAYS`, bounded to
30–3650 days), runs in 1,000-row batches under a PostgreSQL advisory lock, and
records start/completion evidence in `security_events`. It only deletes
`audit_logs`; immutable `usage_events` and `quota_events` remain available for
reconciliation. Manual deletion requires an audited legal or account-deletion
exception, and unbounded `all` deletion is disabled.

## Release stages

| Stage | Change | Go/no-go evidence | Rollback |
| --- | --- | --- | --- |
| A | Process/app factory and security headers | Existing route and compatibility tests pass | Previous image |
| B | Prisma migrations, RLS, dual ownership | Readiness and cross-account negative tests pass | Feature flags; forward migration |
| C | Auth, email, MFA, portals | Sandbox recipients, MFA recovery, and browser checks pass | Close auth/portal flags |
| D | Endpoint/source model | Selected-account endpoint and legacy compatibility metrics | Close endpoint flag |
| E | Quota shadow mode | Ledger and observed dispatch reconciliation has no unexplained delta | Stop shadow job |
| F | Quota enforcement/operator console | Pause, suspension, hard-cap, and waitlist drills pass | Disable enforcement for affected cohort |
| G | Registration | Abuse, capacity, email-delay, and source-health alerts stable | Close registration immediately |

Each promotion requires an operator decision, a recorded compatibility metric,
and a forward-fix plan. Public registration is never enabled by a code deploy
alone.

## Initial SLOs and alerts

- API availability: 99.9% monthly; alert on 5xx and readiness failures.
- API latency: p95 below 500 ms excluding upstream work; alert on sustained breach.
- Auth email: 95% delivered within five minutes; alert on outbox backlog and
  provider failures.
- Quota: alert on reservation failures, reconciliation deltas, and stale
  reservations.
- Sources: alert on health failures, concurrency pressure, and drained capacity.
- Audit: alert on database write failures and queue saturation.

## Operational drills

- **Emergency pause:** close the included-traffic flag, drain affected sources,
  verify BYOK policy, and record the operator reason.
- **Key rotation:** create the replacement encryption/provider key in the secret
  manager, run the reviewed conversion/rotation job, verify reads and writes,
  then revoke the old key. Never put key material in logs or deployment shell
  heredocs.
- **Restore:** restore to an isolated PostgreSQL instance, apply the security
  layer, run readiness and RLS checks, then reconcile quota ledgers before use.
- **Worker recovery:** inspect heartbeat and claimed rows, restart one worker,
  and run the bounded stale-reservation/outbox reconciliation job.
- **Compromise:** revoke sessions and gateway tokens, suspend the account or
  operator, rotate affected provider credentials, preserve the security audit,
  and follow the MFA break-glass procedure in `docs/AUTH_SECURITY.md`.
