# Research — Multi-tenant Firecrawl Platform Restructure

Researched: 2026-07-31
Confidence: high for repository findings and primary-source recommendations; production infrastructure and database contents were not inspected.

## Current repository baseline

### Resolved stack

Backend lockfile:

- Node.js `>=22`
- Express `4.22.2` (`package.json` requests `^4.21.2`)
- `@types/express` `5.x`, currently misaligned with Express 4
- Passport `0.7.0`, express-session `1.19.0`, connect-pg-simple `10.0.0`
- PostgreSQL client `pg` `8.21.0`
- Zod `3.25.76`
- TypeScript `5.7.x`, Vitest `4.1.8`

Frontend lockfile:

- React/React DOM `19.2.7`
- React Router DOM `7.17.0`
- Vite `8.0.16`
- Tailwind CSS `4.3.0`
- TypeScript `6.0.3`

Baseline verification performed before planning:

- Backend typecheck passed.
- Backend tests passed: 19 files, 203 tests.
- Frontend lint passed.
- Builds were not run because they create ignored generated output and were unnecessary for research.

### Existing strengths to preserve

- Strict backend TypeScript and runtime configuration validation with Zod.
- Parameterized PostgreSQL queries and PostgreSQL-backed sessions.
- Password hashing with bcrypt and session regeneration on login.
- Role/status middleware and ownership checks on current API-key routes.
- AES-256-GCM encryption for credentials/settings.
- Request IDs, structured Pino logs, health/readiness endpoints, graceful shutdown, body-size control, and proxy streaming.
- Broad backend unit/integration coverage around proxy, auth, users, settings, and audit behavior.
- React lazy loading, role-aware routing, accessible primitives, and a documented design standard.
- Non-root Docker runtime and multi-stage builds.

### Gaps created or amplified by the new product

- `server.ts` performs configuration, database initialization, migrations, route composition, listening, jobs, and process lifecycle; there is no testable `createApp` boundary.
- One `schema.sql` is executed on every startup. It is not a durable ordered migration history and uses the application runtime connection.
- Tenant ownership is represented directly by `user_id`; there is no account/workspace boundary or membership model.
- The proxy authenticates a global `/v1/*` or `/v2/*` token and uses shared upstream settings. It has no path endpoint identity, funding policy, capacity reservation, or sticky async-job source mapping.
- Existing virtual API tokens are both hashed and reversibly encrypted so they can be redisplayed. Public gateway tokens should become hash-only.
- Cloud keys are stored as one encrypted JSON setting; self-hosted routing is another global setting. They are not independently budgeted, health-checked infrastructure sources.
- The rate limiter is process-local memory keyed by IP, so it does not coordinate multiple instances or support account/operation-specific policies.
- The hourly in-process worker only auto-revokes inactive keys and auto-suspends inactive users. Those policies conflict with the new product and are not safe for multiple API replicas.
- Authentication lacks registration, email verification, password reset, CSRF defense, 2FA, recovery, session inventory/revocation, and security-event notifications.
- Production accepts an empty session secret with a warning/fallback random secret rather than failing closed.
- The React SPA is built and routed entirely under `/admin`; user and operator information architectures are mixed in one layout.
- Frontend API types are handwritten separately from backend behavior and there are no frontend component or browser tests.
- Audit data is queued in process to both JSONL and PostgreSQL and stores complete target URLs. A public scraping platform needs stricter privacy, retention, and bounded analytics.
- The only deployment workflow is disabled and contains stale deployment assumptions/configuration unrelated to the current Compose files.

## Primary-source findings and architectural implications

### Repository and TypeScript organization

npm workspaces provide one root dependency graph, workspace linking, and root command orchestration. Use them instead of maintaining nested independent lockfiles. Keep the number of packages small: API, web, and shared control-plane contracts.

Source: [npm workspaces](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#workspaces)

React Router 7 Data Mode supports route objects outside render, lazy route modules, nested layouts, loaders/actions, and route-level error boundaries. This fits separate public, user, and operator route trees without creating separate frontend applications.

Sources:

- [React Router modes](https://github.com/remix-run/react-router/blob/main/docs/start/modes.md)
- [Lazy route modules](https://github.com/remix-run/react-router/blob/main/decisions/0002-lazy-route-modules.md)
- [Error boundaries](https://github.com/remix-run/react-router/blob/main/docs/how-to/error-boundary.md)

### Express structure and production security

Express recommends TLS, secure cookie settings, non-default cookie names, production session storage, input validation, brute-force protection, dependency review, and disabling `X-Powered-By`. The application already has some of these, but needs CSRF, fail-closed configuration, distributed throttling, and route-specific validation.

Source: [Express production security best practices](https://expressjs.com/en/advanced/best-practice-security/)

Express 5 handles rejected async handler promises automatically, but changes wildcard/path syntax and other APIs. Upgrade only after characterization tests and separately from mechanical file moves.

Source: [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5/)

### Authentication, sessions, and 2FA

OWASP recommends generic responses for login, registration, and reset; long passwords/passphrases without composition rules; breached-password screening; login throttling; reauthentication for sensitive changes; short-lived random single-use reset tokens; server-side session invalidation; secure/HttpOnly/SameSite cookies; session rotation after privilege changes; and idle/absolute timeouts.

TOTP should use a vetted implementation, strict attempt limits, recovery codes, reauthentication before factor changes, out-of-band factor-change notifications, and mandatory MFA for privileged administrators.

Cookie-authenticated SPAs need explicit CSRF protection in addition to SameSite cookies. A session-bound synchronizer token/custom header plus Origin validation and an exact CORS allowlist is appropriate here.

Sources:

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [OWASP Multifactor Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

### PostgreSQL tenancy, migrations, and concurrency

PostgreSQL RLS is default-deny once enabled without a matching policy. Table owners normally bypass it; `FORCE ROW LEVEL SECURITY` applies policies to owners, while superusers and `BYPASSRLS` roles always bypass. Therefore use a non-superuser, non-BYPASSRLS runtime role and test policies against that role. Keep explicit account predicates as the primary application rule; RLS is defense in depth.

`SELECT ... FOR UPDATE` protects rows during quota/admission transitions. `SKIP LOCKED` is suitable for multiple workers claiming waitlist/outbox rows. node-postgres requires every statement in a transaction to use the same checked-out client.

Sources:

- [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [PostgreSQL SELECT locking](https://www.postgresql.org/docs/current/sql-select.html)
- [node-postgres transactions](https://node-postgres.com/features/transactions)
- [node-postgres pooling](https://node-postgres.com/features/pooling)

Replace startup `schema.sql` with ordered migrations. `node-pg-migrate` supports TypeScript migrations and transactional pending migrations by default; execute it as a deployment command with migration credentials, not from API startup.

Source: [node-pg-migrate documentation](https://github.com/salsita/node-pg-migrate/blob/main/docs/src/getting-started.md)

### Quotas and public scraping risk

OWASP API4 recommends execution timeouts, payload/collection limits, operation throttles, and third-party provider spending limits. Counting one crawl request the same as one scrape is the chosen product rule, so separate operation limits are mandatory to stop one nominal request from exhausting infrastructure.

OWASP API7 recommends isolating fetchers, allowlisting schemes/ports, disabling redirects where possible, using maintained URL parsers, and validating all user-controlled URLs. The gateway does not fetch targets directly, but it operates infrastructure that does; source-level egress controls and request validation remain part of the threat model.

Sources:

- [OWASP API4: Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [OWASP API7: Server Side Request Forgery](https://owasp.org/API-Security/editions/2023/en/0xa7-server-side-request-forgery/)

### Credential storage

Passwords and gateway access tokens should be one-way hashed. Provider credentials must be decrypted for upstream calls, so retain authenticated encryption but add purpose binding, key versioning, rotation tooling, and masked metadata. Secrets and encryption keys remain outside source control and database settings.

Sources:

- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

### Brevo transactional email

Brevo sends transactional templates through `POST https://api.brevo.com/v3/smtp/email` with `api-key` authentication, template IDs, parameters, tags, and idempotency headers. Responses expose message IDs; transactional webhooks report delivery/bounce events. Webhooks can be protected with bearer authorization. Rate-limit headers and `429` responses must be honored.

Use a PostgreSQL outbox: commit auth token and email intent together, then let a worker send with an idempotency key. Store the Brevo API key only in deployment secrets; keep sender/template IDs as non-secret operator configuration.

Sources:

- [Send transactional email](https://developers.brevo.com/docs/send-a-transactional-email)
- [Batch/idempotent transactional email](https://developers.brevo.com/docs/batch-send-transactional-emails)
- [Secure webhooks](https://developers.brevo.com/docs/secured-webhooks)
- [Rate-limit headers](https://developers.brevo.com/docs/limit-headers)

### Firecrawl compatibility

Firecrawl uses Bearer API-key authentication and supports custom API base URLs in SDKs. Async batch/crawl responses expose job state and credit usage. A tenant base URL such as `https://host/e/{endpointId}` is therefore compatible with clients that let callers override the API URL, provided the gateway strips the tenant prefix and preserves `/v1` or `/v2` semantics.

Async jobs require a local mapping from account + public job ID to the exact upstream source and credential used at creation; status/cancel/error requests cannot run the normal source-selection algorithm again.

Sources:

- [Firecrawl API onboarding](https://docs.firecrawl.dev/ai-onboarding)
- [Firecrawl documentation repository](https://github.com/firecrawl/firecrawl-docs)
- [Firecrawl SDK custom API URL configuration](https://github.com/firecrawl/firecrawl-docs/blob/main/sdks/ruby.mdx)

## Resulting recommendations

1. Use a modular monolith with a separate worker entrypoint; do not introduce networked microservices or Redis yet.
2. Adopt npm workspaces and one root lockfile, but separate mechanical moves from framework upgrades.
3. Keep direct `pg` access behind module repositories; do not add an ORM during the product rewrite.
4. Add versioned migrations and separate runtime/migration database roles.
5. Introduce `accounts` and memberships even though the first release creates one personal account per user.
6. Use explicit account-scoped repositories plus PostgreSQL RLS defense in depth.
7. Keep one React SPA with public, `/app`, and `/admin` layouts and shared contracts.
8. Use PostgreSQL for quota counters, waitlist claims, email outbox, and notifications at the expected initial scale; abstract worker claims so Redis can be added only when measurements justify it.
9. Treat path endpoint IDs as public identifiers; keep authorization in hash-only gateway tokens.
10. Preserve AES-256-GCM for provider credentials while adding key versions and rotation; remove reversible storage from gateway tokens.
11. Reserve quota before upstream dispatch, finalize after dispatch, and conservatively charge abandoned reservations that may have reached an upstream.
12. Keep raw-request quota semantics but enforce per-operation payload, page, depth, duration, and concurrency limits.
13. Keep registration closed behind a feature flag until isolation, quota admission, and abuse tests pass.
14. Replace dual JSONL/database audit persistence with bounded, privacy-aware PostgreSQL request events plus structured stdout operational logs.
