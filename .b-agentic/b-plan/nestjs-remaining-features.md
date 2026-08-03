# Native NestJS Migration Plan — Remaining API Features

## Goal

Finish the API rewrite as a native NestJS 11 modular monolith on Fastify, preserving all current public behavior while removing the legacy Express application. The result uses one `DATABASE_URL`, a fresh Prisma-managed database, explicit runtime/operator transaction roles, and a standalone Nest worker application context.

## Constraints and non-goals

- Do not mount, call, wrap, or adapt the existing Express app or routers from Nest.
- Use Nest modules, controllers, providers, guards, pipes, interceptors, filters, and lifecycle hooks. Use Fastify request/reply primitives only where streaming proxy behavior requires them.
- Organize by business feature; use `domain/application/infrastructure/presentation` only where complexity warrants it. Keep tests co-located.
- Keep jobs with their owning feature modules. Do not create a central workers module.
- Preserve current paths, status codes, response contracts, request limits, authentication, CSRF, MFA/step-up, audit, rate-limit, tenant/RLS, proxy streaming, and fallback semantics.
- Keep the current Express runtime entrypoint until the native route matrix is complete; do not perform a partial production cutover.
- Do not create Prisma migration history. The final deployment initializes a fresh database from `schema.prisma`, then applies `prisma/security.sql`; API and worker startup never run DDL.
- Preserve unrelated working-tree changes. Delete replaced Express code and obsolete migration/planning/documentation artifacts only in the final cleanup phase.

## Target feature ownership

- `core/`: configuration, database/transaction roles, readiness, logging/error handling, rate limiting.
- `modules/auth/`: existing native identity, sessions, CSRF, password, email verification, and MFA behavior.
- `modules/accounts/`: users, memberships, account state, suspension/block/reactivation, deletion/export.
- `modules/quota/`: periods, enrollment/waitlist, entitlements, reservations, reconciliation, and quota schedules/jobs.
- `modules/gateway-tokens/`: virtual gateway-token creation, listing, validation, activity, and revocation.
- `modules/credentials/`: encrypted tenant provider credentials and sensitive-action verification.
- `modules/sources/`: infrastructure source selection, health, funding provenance, and operator source management.
- `modules/audit/`: request/security/operator audit persistence, querying, deletion policy, and retention job.
- `modules/gateway/`: policy decisions, proxy execution, fallback, async-job virtualization, endpoint routing, and playground proxying.
- `modules/portal/`: `/api/v1/app` composition endpoints backed by the owning feature services.
- `modules/operator/`: `/api/v1/admin` and required `/admin/api` compatibility controllers, operator guards, reasons, step-up, analytics, notifications, and configuration.
- `modules/email/`: Brevo webhook, encrypted outbox delivery, and outbox worker.

## Ordered execution plan

### 1. Freeze the compatibility contract and module boundaries `[AFK]`

1. Build a checked route matrix from `app.ts`, every legacy router, the web API clients, and `packages/contracts`; include method, path, body limit, auth/role/MFA/CSRF requirements, response schema, and owning Nest module.
2. Add characterization tests for uncovered high-risk behavior before moving code: proxy streaming/abort/header filtering, async-job create/poll/cancel mapping, operator mutation gates, portal contracts, webhook verification, static SPA fallbacks, and graceful shutdown.
3. Define shared request metadata and decorators (`current user`, `account`, request ID, client IP/user agent) without retaining Express request types.
4. Record a temporary deletion checklist for every Express-only file and package; do not delete anything yet.

**Done when:** every mounted legacy route has exactly one future owner and a compatibility test or an explicit test task; no new controller needs to import an Express router or handler.

### 2. Complete the persistence and security foundation `[AFK]`

1. Replace remaining feature access to `getPrisma`, legacy transaction helpers, and database adapters with injected repositories that execute only through `TransactionService`.
2. Add reusable account-context and operator-context application services/guards while keeping role selection inside database transactions.
3. Move security-event and audit writes behind injectable ports so Auth and later modules no longer import legacy helpers.
4. Add live PostgreSQL integration coverage for the single login role, `SET LOCAL ROLE`, forced RLS isolation, operator-only tables, Prisma session persistence, readiness posture, and `security.sql` reapplication.

**Done when:** native modules cannot inject `PrismaService` directly; role/RLS behavior is demonstrated against a disposable PostgreSQL database, not only mocks.

**Approval gate `[HITL]`:** obtain permission and a disposable PostgreSQL target before starting database-backed integration tests or applying `security.sql`.

### 3. Migrate Accounts and Quota first `[AFK]`

1. Create `AccountsModule` for user/account lookup, updates, administrative lifecycle changes, export, deletion requests, membership resolution, and account status rules.
2. Remove Auth's imports of legacy quota/database adapters by exposing narrow account-admission and suspension-reactivation application ports.
3. Create `QuotaModule` for policy, periods, enrollment/waitlist, entitlements, reservations, adjustment/revocation, events, and reconciliation.
4. Move quota schedules and periodic quota work into providers exported by `QuotaModule` and registered by `WorkerAppModule`.
5. Port `/admin/api/users` and `/admin/api/quota` only as compatibility controllers; enforce admin, verified MFA, recent step-up where currently required, mutation reason, audit, and database readiness.

**Done when:** account and quota unit/contract tests pass natively; verification admission, suspension/reactivation, proxy reservation primitives, and quota jobs no longer call legacy modules.

### 4. Migrate gateway tokens, credentials, settings, and infrastructure sources `[AFK]`

1. Create `GatewayTokensModule` for user-owned and compatibility-admin token endpoints, one-time plaintext creation, hashing, scopes, expiry/inactivity, ownership, activity touch, and bulk revocation.
2. Create `CredentialsModule` for encrypted Firecrawl credentials, metadata-only reads, replace/delete/validate flows, reauthentication, and security events.
3. Create `SourcesModule` for source repositories, funding selection, credential association, health/test actions, and source enable/disable lifecycle.
4. Move routing configuration currently owned by legacy settings into the appropriate source/config providers; retain `SettingsModule` only for genuinely persisted operator settings.
5. Preserve `/api/v1/app/tokens`, `/api/v1/app/credentials`, `/admin/api/api-keys`, `/admin/api/credentials`, and `/admin/api/settings` contracts during the compatibility window.

**Done when:** plaintext keys/credentials are never logged or returned after creation; tenant isolation, reauthentication, audit events, and current web-client contract tests pass with native controllers.

### 5. Rebuild the gateway and async-job pipeline natively `[AFK]`

1. Split `proxy.ts` into injectable application services for authentication, route policy, source selection, quota reservation/finalization, upstream execution, fallback, job virtualization, response projection, and redacted audit recording.
2. Implement a native `GatewayController` for `/v1/*`, `/v2/*`, and `/e/:endpointId/v1|v2/*`; endpoint IDs must not be forwarded upstream.
3. Use low-level Fastify reply/hijack and Node streams only in the transport service. Preserve backpressure, client-abort cancellation, timeout cleanup, response status/headers/body, and bounded buffering for fallback inspection.
4. Port gateway-token and tenant-endpoint authorization, request-size limits, route-mode policy, cloud/self-hosted fallback, source provenance, and atomic included-quota accounting without weakening fail-closed behavior.
5. Move async gateway-job create/poll/cancel ID translation into `GatewayModule`; ensure all mappings remain account-scoped and RLS-protected.
6. Implement both authenticated playground prefixes as thin native gateway entrypoints restricted to `/v1/*` and `/v2/*`.

**Done when:** existing proxy, quota, policy, data-plane, playground, and async-job tests have native equivalents; streaming and fallback are proven through Fastify injection or a real HTTP boundary; no Nest gateway provider imports `proxy.ts`, `policy.ts`, or legacy job helpers.

### 6. Migrate the user portal API `[AFK]`

1. Create `PortalModule` controllers for overview/dashboard, account read/update, export/deletion request, endpoint, quota, usage, request history, and security events.
2. Compose responses from Accounts, Quota, GatewayTokens, Credentials, Audit, and Sources application services rather than duplicating repositories or domain rules.
3. Validate all inputs and outputs against the existing shared Zod contracts consumed by `apps/web/src/features/portal/api.ts`.
4. Preserve pagination bounds, privacy labels, sensitive-action reauthentication, and account ownership checks.

**Done when:** every `portalApi` call succeeds against native E2E tests with its shared response schema; `app-api.ts` has no remaining unique behavior.

### 7. Migrate operator and legacy-admin surfaces `[AFK]`

1. Create `OperatorModule` guards for platform-admin authorization, verified MFA, recent step-up, database readiness, and required mutation reasons.
2. Port account operations, capacity/quota operations, infrastructure and credential management, analytics, request views, notifications, security views, and configuration.
3. Make mutation audit persistence part of the same application operation/transaction where atomicity is required; reject the mutation if required audit persistence fails.
4. Port only legacy `/admin/api` endpoints still used by the shipped web UI. Remove any legacy endpoint only after repository-wide caller evidence and a compatibility decision.
5. Preserve bounded query windows, pagination, redaction, and operator-role database access.

**Done when:** all operator-console calls and retained legacy-admin routes pass native authorization and contract E2E tests; every mutation demonstrates role + MFA + step-up + reason + audit + readiness enforcement.

### 8. Migrate email/webhooks and build the real standalone worker `[AFK]`

1. Create `EmailModule` for outbox creation/delivery state and the Brevo webhook at `/api/v1/webhooks/*`, including token/signature checks, the 64 KB limit, idempotency, and audit-safe logging.
2. Convert email delivery, audit retention, and quota scheduling into lifecycle-managed providers owned and exported by Email, Audit, and Quota modules.
3. Import those feature modules into `WorkerAppModule`; start schedules from Nest lifecycle hooks and stop them through application shutdown hooks.
4. Preserve heartbeat behavior, error logging, graceful stop, and Prisma disconnection in `worker-main.ts` without calling `startBackgroundJobs` or `worker.ts`.

**Done when:** worker tests prove each owning module starts once, stops cleanly, writes heartbeat state, and resumes durable database work after restart; webhook contract tests pass natively.

### 9. Restore static UI behavior and perform atomic runtime cutover `[AFK]`

1. Add Fastify static delivery and SPA fallbacks only for the current application route trees; `/api`, `/admin/api`, `/e`, health, and readiness must continue to receive API handlers/404s.
2. Preserve the authentication-disabled `/admin` response and existing security/CORS/compression behavior.
3. Add startup bootstrap behavior still required by the product, but keep schema/role DDL outside API and worker startup.
4. Add graceful shutdown for Fastify, worker providers, audit flush, in-flight connections/streams, and Prisma.
5. Change package/container/Compose entrypoints atomically from `dist/server.js` and `dist/worker.js` to `dist/main.js` and `dist/worker-main.js` only after the route matrix is complete.
6. Run smoke checks for `/health`, `/ready`, auth/session/CSRF, portal, operator, `/v1`, `/v2`, `/e/:endpointId`, playground, webhook, static UI, and worker heartbeat against the native processes.

**Done when:** production scripts start only Nest entrypoints; no request is delegated to Express; all public route families have observable smoke evidence.

### 10. Remove the legacy stack and obsolete artifacts `[AFK]`

1. Delete replaced Express composition, routers, middleware wrappers, Passport/session adapters, old proxy/worker entrypoints, compatibility database adapters, and tests superseded by native tests.
2. Remove Express-only dependencies and type packages after `rg` proves there are no runtime or test imports. Refresh `package-lock.json` only for the approved removals.
3. Remove `apps/api/migrations`, Prisma migration history, migration/preflight/baseline scripts, and migration service/workflow wiring. Keep `schema.prisma` and `security.sql` as the fresh-database sources.
4. Update `.env.example`, Compose, Dockerfile/entrypoint, workflow, README/SELF_HOST, and agent instructions to one `DATABASE_URL` and the Nest commands.
5. Delete obsolete architecture/operations documentation and all temporary `.b-agentic/b-plan` files, including this plan, once their useful content is reflected in maintained source-facing documentation.
6. Resolve or explicitly block cutover on production dependency advisories; do not hide them with an ineffective override.

**Done when:** repository search finds no Express/Passport/express-session imports, no old entrypoint references, no `OPERATOR_DATABASE_URL` or `MIGRATION_DATABASE_URL`, no migration pipeline, and no deleted-path references.

## Verification gates

Run focused tests after each module and the following gates before cutover:

```bash
npm run api:typecheck
npm run api:build
npm run api:test
npm run prisma:validate --workspace @firecrawl/api
npm run web:typecheck
npm run web:lint
npm run web:build
npm run typecheck
npm run lint
npm run test
npm run build
```

Also require:

- Native Fastify E2E coverage for every route-matrix entry.
- Live PostgreSQL role/RLS/session/quota/job integration tests using the final single login credential.
- Real HTTP streaming, abort, timeout, and fallback tests for the gateway boundary.
- A clean dependency audit or an explicit user-approved release exception for upstream-only advisories.
- `git diff --check` and a final changed-code review before any commit or deployment.

## Approval point

This plan is ready for phased implementation. Approve one numbered phase at a time, beginning with **Phase 1: compatibility contract and module boundaries**.
