# Multi-tenant Firecrawl Platform — Master Plan

Status: proposed for approval
Scope: repository-wide restructure and product transition
Implementation: not started

## Goal

Turn the current personal hybrid Firecrawl gateway into a secure modular monolith that provides:

- A public account and authentication experience.
- One personal tenant account per registered user, with a path-addressable endpoint.
- User-owned Firecrawl credentials (BYOK).
- Operator-owned Firecrawl Cloud keys and self-hosted sources.
- A permanent recurring free-tier commitment of 100 infrastructure requests per verified, admitted, non-suspended account each UTC calendar month.
- A capacity ceiling that stops new free-tier admissions without blocking BYOK usage.
- Separate user and operator experiences.
- Auditable quotas, source selection, notifications, analytics, and security controls.

## Fixed product decisions

1. `100` is the initial default monthly request grant; it is configurable.
2. An admitted account keeps its recurring free-tier capacity slot indefinitely until an operator explicitly revokes free-tier eligibility.
3. Suspended accounts cannot use included infrastructure and receive no new monthly entitlement, but temporary suspension does not release the permanent slot.
4. Verified accounts that cannot fit under the commitment ceiling are waitlisted and may still use BYOK.
5. Unused requests expire at period end and do not roll over.
6. One client request routed to operator infrastructure counts once, regardless of internal retries/fallbacks. Requests rejected before upstream dispatch do not count.
7. User BYOK traffic does not consume the included allowance, but remains subject to abuse, concurrency, body-size, and operation limits.
8. The tenant endpoint identifier is routing identity, not authentication. A gateway token remains required.
9. The repository continues to proxy externally hosted Firecrawl services and PostgreSQL; it does not embed those runtimes.

## Recommended target architecture

Use one deployable modular monolith, not microservices. Keep HTTP and worker entrypoints independently runnable from the same backend package.

```text
.
├── apps/
│   ├── api/                     # Express control plane + Firecrawl data plane
│   │   ├── src/app.ts           # createApp; no listening or process exits
│   │   ├── src/server.ts        # process lifecycle
│   │   ├── src/worker.ts        # outbox, quota periods, waitlist, health alerts
│   │   ├── src/modules/         # vertical product modules
│   │   ├── src/platform/        # config, db, logging, crypto, HTTP primitives
│   │   └── migrations/          # ordered PostgreSQL migrations
│   └── web/                     # one React SPA with public/app/admin route trees
├── packages/
│   └── contracts/               # Zod control-plane contracts + inferred TS types
├── docs/
│   ├── architecture/            # ADRs, data model, threat model, API conventions
│   ├── operations/              # migration, backup, key rotation, incident runbooks
│   └── DESIGN.md
├── deploy/                      # Docker and Compose deployment assets
├── package.json                 # npm workspaces and root verification scripts
├── package-lock.json            # one lockfile
└── tsconfig.base.json
```

Backend modules should own routes, application services, repositories, contracts, and tests:

```text
modules/
├── auth/
├── accounts/
├── tenant-endpoints/
├── gateway-tokens/
├── provider-credentials/
├── infrastructure-sources/
├── routing/
├── quotas/
├── usage/
├── notifications/
├── analytics/
└── operator/
```

Dependencies flow inward: HTTP routes -> application services -> domain policy -> repository interfaces. Modules may consume another module's public service, not its tables or private repository.

## Public contracts

- Public auth/control API: `/api/v1/auth/*`
- User control API: `/api/v1/app/*`
- Operator control API: `/api/v1/admin/*`
- Tenant Firecrawl base URL: `/e/:endpointId`, followed by `/v1/*` or `/v2/*`
- User portal: `/app/*`
- Operator portal: `/admin/*`
- Public auth pages: `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`
- Existing `/v1/*`, `/v2/*`, and `/admin/api/*` receive a documented compatibility/deprecation window rather than disappearing in one release.

## Cross-cutting invariants

- Every tenant-owned row carries `account_id`; user identity and tenant ownership are not conflated.
- Every user API query is account-scoped in repositories and protected by PostgreSQL RLS as defense in depth.
- Operator access is enforced server-side; frontend route guards are only UX.
- Gateway tokens are hashed and shown once. Provider credentials are reversibly encrypted, masked, versioned, and never returned after creation.
- The application runtime role cannot run schema migrations.
- Quota admission, reservation, finalization, and release are transactional and concurrency-safe.
- The operator commitment ceiling cannot be lowered below existing permanent commitments without an explicit destructive override flow.
- Full target URLs, authorization headers, cookies, reset tokens, TOTP secrets, recovery codes, and credentials never enter logs or analytics.
- Public registration remains closed until tenant isolation, verification, capacity admission, quota enforcement, and abuse controls pass integration tests.

## Phase map

1. [Repository foundation](01-repository-foundation.md)
2. [Database, migrations, and tenant isolation](02-database-tenancy-migrations.md)
3. [Authentication, Brevo email, sessions, and 2FA](03-auth-email-security.md)
4. [Tenant data plane, credentials, and infrastructure routing](04-data-plane-credentials-routing.md)
5. [Recurring quota and capacity control](05-quota-capacity.md)
6. [Public site and user portal](06-user-portal.md)
7. [Operator console, notifications, and analytics](07-operator-console.md)
8. [Testing, security, operations, and rollout](08-hardening-rollout.md)

Research and rationale: [RESEARCH.md](RESEARCH.md).

## Sequencing and release gates

```text
Phase 1
  └─ Phase 2
      ├─ Phase 3 (registration remains closed)
      └─ Phase 4 (new endpoint remains feature-flagged)
           └─ Phase 5
               ├─ Phase 6
               └─ Phase 7
                    └─ Phase 8 -> production registration may open
```

Phase 3 and Phase 4 may proceed in parallel after Phase 2 if they use migrations and module contracts rather than editing the same bootstrap files.

## Program-level done when

- A verified account is admitted only when its permanent monthly commitment fits atomically beneath the configured ceiling; otherwise it is waitlisted.
- Every admitted active account receives exactly one 100-request entitlement per UTC month; suspended accounts cannot receive or spend it.
- Concurrent requests cannot overspend account allowance or the platform hard cap.
- A user can call `https://host/e/{endpointId}/v2/...` with a hashed gateway token and choose an allowed BYOK/included/automatic funding mode.
- An operator can add masked Cloud credentials and self-hosted sources, set budgets/concurrency, control commitment and hard ceilings, suspend users, revoke free-tier seats, and process the waitlist.
- User APIs and UI expose only the current account; operator APIs require operator authorization and step-up authentication.
- Registration, verification, password reset, TOTP, recovery codes, session revocation, and Brevo delivery events are covered by security tests.
- Root typecheck, lint, unit/integration tests, web build, API build, migration checks, and container build pass in CI.
- A documented migration preserves existing users, token hashes, operator settings, and usable old routes through the compatibility window.

## Required implementation approvals

Each phase must be approved before execution. In particular, ask before:

- Creating the root workspace lockfile or adding/upgrading dependencies.
- Introducing `node-pg-migrate`, a TOTP library, React Testing Library, or Playwright.
- Applying migrations to any database.
- Running one-time credential/settings data conversion.
- Changing deployment topology to separate API, worker, and migration commands.
- Enabling registration, sending real Brevo emails, or changing external infrastructure.
