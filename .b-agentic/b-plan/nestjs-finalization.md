# Native NestJS Migration — Finalization Plan

## Goal

Finish the NestJS 11/Fastify migration without changing the public Firecrawl gateway, portal, operator, webhook, worker, or static-UI contracts. The native runtime entrypoints are now selected by the API package and Docker entrypoint, but the repository still contains the Express compatibility implementation and several parity/verification gaps.

## Current state

Already implemented in the working tree:

- Native Fastify/Nest bootstrap, authentication, sessions, CSRF, health/readiness, static UI, portal, gateway tokens, credentials, settings, infrastructure sources, quota, gateway/proxy, operator, audit, webhook, and quota-worker slices.
- Native `/v1/*`, `/v2/*`, `/e/:endpointId/v1|v2/*`, playground, portal, operator, and compatibility-admin controllers.
- Native runtime entrypoints: `apps/api/dist/main.js` and `apps/api/dist/worker-main.js`.
- API verification currently passes: typecheck, build, 56 test files, 402 tests, and `git diff --check`.

Not yet proven or complete:

- The route matrix still records most migrated routes as `Legacy` because native contract coverage is incomplete.
- `WorkerAppModule` currently imports quota/webhook/worker modules but not native email delivery or audit-retention ownership.
- Express composition, legacy routers, Passport/session adapters, proxy implementation, tests, and dependencies remain in the repository.
- Live PostgreSQL migration, security SQL, role, grant, RLS, and readiness verification has not been run.

## Constraints and non-goals

- Preserve unrelated working-tree changes; do not commit, push, or delete broad legacy surfaces without explicit approval.
- Do not read or expose secrets. Use a disposable PostgreSQL target for live database checks only after approval.
- Do not apply DDL from API or worker startup. Keep database initialization/security SQL as explicit deployment operations.
- Do not remove Express code until native contract tests, caller evidence, and the final cutover decision are complete.
- Prefer the smallest native parity fix over broad refactors.

## Ordered execution plan

### 1. Close native behavior gaps `[AFK]`

1. Add native email/outbox delivery ownership under an email feature module. Preserve encrypted outbox state transitions, retry/dead-letter behavior, Brevo webhook idempotency, and safe logging.
2. Add native audit-retention scheduling under the audit feature boundary. Preserve bounded deletion/retention semantics and graceful timer cleanup.
3. Import the email and audit worker providers into `WorkerAppModule`; remove the worker's dependency on legacy `startBackgroundJobs`/`worker.ts` behavior.
4. Wire Fastify request-abort signals into `GatewayTransportService` from `GatewayController` and verify stream cleanup releases source-concurrency leases.
5. Complete gateway parity for BYOK last-use touches, cloud credential/source fallback and retry behavior, async lifecycle pinning, quota finalize/release paths, and privacy/header behavior where characterization tests expose differences.

**Done when:** native worker startup performs all required durable work without legacy job imports; gateway cancellation, fallback, BYOK metadata, async lifecycle, and quota behavior have native tests demonstrating the intended observable results.

### 2. Build the native route-contract test matrix `[AFK]`

1. Convert each row in `docs/architecture/nest-route-matrix.md` into a native Fastify contract test or explicitly document why it is not applicable.
2. Add focused tests for webhook bearer validation, duplicate events, and `202` responses.
3. Add gateway tests for `/v1`, `/v2`, endpoint routes, playground prefixes, streaming/abort/timeout, header filtering, async create/poll/cancel, fallback, quota headers, token scopes, and private-target protection.
4. Add portal tests for overview/account/update/endpoint/quota/usage/history/security/export/deletion and shared response envelopes.
5. Add operator tests for platform-admin/MFA/step-up/reason/readiness/audit gates, account mutations, credential actions, quota actions, configuration, notifications, analytics, and audit deletion exceptions.
6. Add static UI and negative-space tests proving API, endpoint, health, and readiness paths never fall through to SPA HTML.
7. Update route-matrix statuses from `Legacy` to `Native` only when method, path, access gate, body limit, and response shape are covered.

**Done when:** every route retained by the native runtime has an evidence link to a native contract test, and no matrix row is marked `Native` based only on controller registration.

### 3. Verify PostgreSQL and security behavior `[HITL]`

1. Obtain approval and a disposable PostgreSQL target with the required runtime/operator credentials.
2. Validate the Prisma schema and deploy the fresh schema using the documented migration procedure; apply `prisma/security.sql` explicitly outside API/worker startup.
3. Verify runtime/operator transaction roles, grants, forced RLS, account isolation, operator-only access, session persistence, quota reservation atomicity, gateway-job ownership, audit writes, and readiness behavior.
4. Exercise failure cases: unavailable database, missing security prerequisites, transaction timeout/lock timeout, revoked session, and cross-account access.
5. Record commands, observed results, and any required SQL/schema fixes in the database operations documentation without exposing credentials.

**Done when:** the native runtime and worker pass live database/security checks against the final schema and security layer, including cross-tenant negative tests.

### 4. Validate the cutover boundary `[AFK]`

1. Run repository-wide caller checks for `/api/v1`, `/admin/api`, `/e`, webhook, static, and worker endpoints against `apps/web/src`, deployment files, workflows, docs, and tests.
2. Verify the shipped UI's CSRF, request ID, reason, step-up, session, token, credential, operator, and playground requests against the native process.
3. Smoke-test `apps/api/dist/main.js` and `apps/api/dist/worker-main.js` separately with `/health`, `/ready`, authentication, static UI, gateway, webhook, and worker heartbeat checks.
4. Confirm Docker/Compose/workflow references use the native entrypoints and that no process starts the Express server.
5. Resolve any compatibility alias mismatch before deleting the legacy runtime.

**Done when:** all repository callers target supported native/compatibility paths and native process smoke tests pass without loading `app.ts`, `server.ts`, `proxy.ts`, Passport, or Express session code.

### 5. Remove the Express compatibility stack `[HITL]`

1. Obtain explicit approval for dependency and lockfile changes and for deleting the legacy implementation.
2. Delete replaced Express composition and route files listed in `.b-agentic/nest-deletion-checklist.md`, retaining only domain/persistence code still referenced by native modules.
3. Remove legacy proxy/job/auth/session adapters, obsolete Express tests, and unused compatibility helpers after reference analysis.
4. Remove `express`, `express-session`, Passport, Express middleware packages, related type packages, and obsolete test dependencies; refresh `package-lock.json` only for these approved removals.
5. Run `rg` checks proving no runtime/test imports of Express, Passport, or `express-session`, and no references to `dist/server.js`, `src/server.ts`, or the deleted legacy paths.
6. Update `AGENTS.md` through its canonical source if repository architecture/entrypoint guidance is now stale; update maintained compatibility, deployment, README, and self-hosting documentation.
7. Retire the temporary deletion checklist and superseded plan content only after the final review confirms the migration is complete.

**Done when:** the repository contains only native Nest/Fastify API and worker composition, dependency metadata has no legacy runtime packages, and all deleted-path references are removed or intentionally documented.

## Final verification gates

Run from the repository root:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run prisma:validate --workspace @firecrawl/api
npm run web:typecheck
npm run web:lint
npm run web:build
git diff --check
```

Also require:

- Native contract coverage for every retained route-matrix row.
- Live PostgreSQL role/RLS/session/quota/job verification.
- Real HTTP gateway streaming, abort, timeout, and fallback evidence.
- Clean repository-wide legacy-import and old-entrypoint searches.
- Changed-code review before any commit or deployment.

## Approval point

This plan is ready for phased implementation. The recommended next step is **Phase 1: close native worker and gateway parity gaps**, followed by the route-contract test matrix. Database validation and Express/dependency deletion require explicit approval before execution.
