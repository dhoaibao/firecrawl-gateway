# Phase 8 — Testing, Security, Operations, and Rollout

Depends on: Phases 1–7
Release gate: production registration remains disabled until this phase is approved

## Scope

- Validate tenant and quota correctness under concurrency and failure.
- Harden public API/auth/credential surfaces.
- Establish production CI/CD, migration, worker, backup, observability, and incident procedures.
- Roll out through compatibility/shadow stages with measured rollback points.

## Steps

### 1. Establish the test pyramid

Backend:

- Unit tests for domain policy, schemas, crypto envelopes, source selection, and state machines.
- Repository/integration tests against a real disposable PostgreSQL instance and runtime RLS role.
- Route tests through `createApp` with fake Brevo and fake Firecrawl servers.
- Concurrency tests for admission, entitlement creation, quota reservation, waitlist/outbox claims, suspension, and revocation.
- Contract tests for control-plane schemas and legacy compatibility.

Frontend:

- Component tests for forms, quota states, one-time secrets, permissions, and confirmation flows.
- Browser tests for public, user, and operator critical paths.
- Accessibility and responsive visual checks.

Done when:

- CI has no dependency on a developer database or real external provider.
- Every cross-tenant object access and every quota state transition has a negative test.
- Coverage thresholds target security/domain modules rather than rewarding generated or trivial UI lines.

### 2. Complete a threat model and security review

Document assets, trust boundaries, attacker types, abuse cases, and mitigations for:

- Account enumeration, credential stuffing, reset/verification abuse, session fixation, CSRF, and MFA recovery.
- Broken object-level authorization and operator privilege escalation.
- Gateway-token theft and provider-credential disclosure/rotation.
- Quota races, replay, request amplification, async-job abuse, and source budget exhaustion.
- SSRF/private-network scraping, DNS rebinding, oversized responses, redirect behavior, and webhook abuse.
- Log/analytics privacy, secrets in errors, backups, and support workflows.

Perform dependency audit, secret scan, static analysis, and targeted manual review before opening registration.

Done when:

- Every high-risk threat has a tested control or an explicit production blocker.
- Operator break-glass and credential-compromise procedures are documented and tested.

### 3. Harden HTTP and runtime behavior

- TLS at the trusted edge; exact `trust proxy` configuration with deployment tests.
- Helmet/CSP appropriate to the SPA, disabled `X-Powered-By`, custom 404/error responses, and no production stacks.
- Exact credentialed CORS origins and CSRF/Origin enforcement.
- Distributed per-IP/account/token/operation/auth rate limits with standard retry/reset metadata.
- Payload, parameter, response-buffer, timeout, and concurrency ceilings.
- Request IDs validated/bounded before reuse.
- Graceful draining for API and worker; sticky jobs remain pollable.

Done when:

- Security header, CORS, CSRF, proxy-header spoofing, and rate-limit tests pass behind the intended reverse proxy topology.
- Load shedding returns controlled responses without quota/account corruption.

### 4. Finalize audit, privacy, and retention

- Replace JSONL as canonical audit storage with PostgreSQL usage/operator/security events and structured stdout operational logs.
- Redact query strings, target paths/URLs, authorization, cookies, email tokens, TOTP material, and credentials before persistence/logging.
- Separate user-visible request history from operator/security audit.
- Add indexed retention jobs with bounded batches and legal/account-deletion exceptions.
- Document export/deletion behavior and retention periods.

Done when:

- Automated secret/PII canary tests find no canary in logs, analytics, traces, or API responses.
- Retention jobs cannot delete quota ledger records required for reconciliation before their approved horizon.

### 5. Build production image and process topology

Produce one immutable image with explicit commands:

- `migrate`: deployment job, privileged migration DB role.
- `api`: HTTP only, runtime DB role.
- `worker`: outbox, periods, waitlist, health/notification jobs, runtime DB role.

- Run as non-root with read-only root filesystem and writable temporary/data paths only where required.
- Remove the JSONL volume if no longer needed.
- Add API liveness/readiness, worker heartbeat/readiness, schema-version, and dependency checks.
- Pin a supported Node 22 image digest/version and produce build metadata/SBOM if the delivery environment supports it.

Done when:

- Migration completes before API/worker rollout.
- Multiple workers coordinate through row claims without duplicate processing.
- Container termination drains requests/jobs within bounded shutdown time.

### 6. Replace disabled deployment workflow

CI on pull requests/main:

- Clean workspace install.
- Typecheck/lint/unit/integration/component tests.
- Web/API build and migrations-from-zero/current-schema tests.
- Docker build, dependency review, and security scans.

CD remains manually approved:

- Backup/preflight.
- Run migrations once.
- Deploy API/worker with feature flags closed.
- Smoke/readiness tests.
- Promote flags only after metrics pass.
- Never rebuild `.env` through interpolated remote shell heredocs; use the deployment platform's secret mechanism.

Done when:

- A staging-equivalent deployment and rollback rehearsal succeeds without real-user data.
- Workflow permissions and environments require explicit production approval.

### 7. Roll out incrementally

#### Release A — structural foundation

- Workspace/app-factory/module changes only.
- Same database, routes, UI, and behavior.

#### Release B — migrations and dual ownership

- Add accounts/memberships/account IDs and RLS table by table.
- Dual-read/write; public registration closed.

#### Release C — auth and portals behind flags

- Enable Brevo sandbox/test recipients, verification, MFA, and new SPA routes for operators/test users.

#### Release D — tenant endpoint and source model

- Convert settings to sources, enable `/e/:endpointId` for selected accounts, preserve legacy routes.

#### Release E — quota shadow mode

- Calculate admissions/reservations/charges but do not reject; compare ledger to observed dispatches.
- Reconcile discrepancies before enforcement.

#### Release F — quota enforcement and operator console

- Enforce for selected accounts, then all existing accounts.
- Validate suspension, hard cap, waitlist, and emergency pause drills.

#### Release G — public registration

- Set finite commitment/hard ceilings and alert thresholds.
- Open invite-only first, then public after abuse/capacity metrics are stable.

Done when:

- Each release has a go/no-go checklist, compatibility metric, and forward-fix/flag rollback.
- No release requires destructive database rollback.

### 8. Deprecate legacy behavior only from evidence

- Track old `/v1/*`, `/v2/*`, `/admin/api/*`, old UI entry points, legacy setting reads, and encrypted gateway-token value usage.
- Publish migration instructions and deprecation headers.
- Remove only after usage reaches the approved threshold and all existing credentials/settings have migrated.
- Remove old schema columns in a later cleanup migration, never in the first compatibility release.

Done when:

- No active integration depends on removed contracts according to production telemetry and operator confirmation.

### 9. Add operational runbooks and SLOs

Document:

- Database backup/restore and migration forward-fix.
- Master encryption-key and provider-credential rotation.
- Brevo outage/backlog handling.
- Source outage/draining and global included-traffic pause.
- Quota reconciliation and manual ledger adjustment.
- Hard-cap reached and waitlist surge.
- Account compromise, operator recovery, and session revocation.
- Worker backlog/stale reservation recovery.

Define initial SLOs/alerts for API availability, p95 latency excluding long upstream work, auth email delay, outbox backlog, quota reservation failures, source health, and audit write failures.

Done when:

- Operators can execute emergency pause, source drain, key rotation, and restoration drills from documented procedures.

## Final production acceptance

- Tenant isolation and RLS suites pass using production-like database roles.
- Quota/account/source invariants survive load and fault injection.
- No plaintext credentials or auth secrets appear after creation/setup flows.
- Included requests stop exactly at account/platform limits while BYOK behavior follows policy.
- Suspended accounts cannot authenticate or consume traffic and do not receive monthly entitlements.
- Capacity exhaustion waitlists new verified accounts and alerts operators without blocking BYOK registration/use.
- Staging migration, backup/restore, API/worker deployment, and rollback rehearsal are signed off.
- Public registration is enabled only through an explicit operator decision.
