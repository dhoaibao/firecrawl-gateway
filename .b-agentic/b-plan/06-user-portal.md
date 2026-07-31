# Phase 6 — Public Site and User Portal

Depends on: Phases 3, 4, and 5
Design prerequisite: refresh `docs/DESIGN.md` through the design workflow before implementing new screens

## Scope

- Move the React build base from an admin-only SPA to one application with public, user, and operator route trees.
- Create registration/authentication screens and a tenant-scoped user portal.
- Remove operator user/configuration concerns from the user navigation.
- Expose endpoint, gateway token, BYOK, quota, usage, security, and account controls safely.

## Route architecture

Use React Router 7 Data Mode with route objects outside render, lazy route modules, nested layouts, loaders/actions, and route-level error boundaries.

```text
/public layout
  /login
  /register
  /verify-email
  /forgot-password
  /reset-password

/app layout (authenticated + verified)
  /app
  /app/endpoint
  /app/tokens
  /app/credentials
  /app/usage
  /app/request-history
  /app/playground
  /app/security
  /app/account

/admin layout (operator + MFA; implemented in Phase 7)
```

Frontend guards improve navigation only. Every API route repeats authorization and tenant scoping server-side.

## Frontend organization

```text
apps/web/src/
├── app/                 # router, providers, root errors, layouts
├── features/
│   ├── auth/
│   ├── endpoint/
│   ├── gateway-tokens/
│   ├── provider-credentials/
│   ├── quota/
│   ├── usage/
│   ├── request-history/
│   └── account-security/
├── components/ui/       # visual primitives only
├── lib/api/             # fetch client, CSRF, contract parsing
└── styles/
```

Feature modules own route components, API adapters, domain-specific components, and tests. Avoid a global dumping-ground `types/index.ts`; consume `@platform/contracts` for API shapes.

## Steps

### 1. Establish public/app layouts and API client

- Change Vite/static serving so `/login`, `/app/*`, and `/admin/*` resolve to the SPA while `/api/*`, `/e/*`, health, and readiness never do.
- Build `createBrowserRouter` route trees with lazy modules and scoped error boundaries.
- Add one typed fetch client that sends credentials, CSRF headers on mutations, request IDs where appropriate, and parses shared response/error contracts.
- Centralize 401 session refresh/logout and 403 verification/MFA handling without retry loops.
- Preserve a temporary redirect from the old `/admin/login` and ordinary-user `/admin` entry points.

Done when:

- Direct navigation/refresh works for every public and app route.
- API/tenant endpoint 404s are never swallowed by SPA fallback.
- Contract parse failures render safe generic errors and are observable without leaking payloads.

### 2. Implement public authentication screens

- Registration with generic completion state, password guidance, consent links, and registration-closed/waitlist messaging.
- Email verification result and resend flow.
- Login followed by TOTP/recovery challenge when required.
- Forgot/reset password flows with generic request state.
- Accessible, non-enumerating errors and loading/disabled states.

Done when:

- Keyboard-only and screen-reader labels are complete.
- Refresh/back navigation cannot expose reset, recovery, or TOTP secrets.
- Suspended/blocked users receive a generic access response and support path appropriate to policy.

### 3. Build the user dashboard

Show only the current account:

- Current monthly included limit, consumed, reserved/in-flight, remaining, and UTC reset date.
- Free-tier state: enrolled, waitlisted, suspended, or BYOK-only.
- Funding split: included versus BYOK.
- Endpoint status and recent success/error/latency summaries.
- Capacity-unavailable messaging without revealing global operator capacity.

Done when:

- Dashboard values reconcile with the user usage API.
- Suspended/waitlisted/exhausted states have actionable but non-misleading copy.

### 4. Build endpoint and gateway-token management

- Show immutable tenant base URL and copyable Firecrawl SDK/cURL examples.
- Create scoped gateway tokens; reveal plaintext once in a confirmation dialog.
- List prefix, scopes, created/last-used/expiry/status; revoke and configure user-owned expiry/inactivity rules.
- Never provide “copy existing secret.”
- Explain that endpoint ID is public and token is secret.

Done when:

- Secret disappears after dialog/navigation and is absent from browser persistence and telemetry.
- Token creation/revocation/expiry behavior is reflected without a full reload.

### 5. Build BYOK credential management

- Add/replace/delete user Firecrawl Cloud credentials.
- Display only mask, health, last validation/use, and replacement status.
- Allow funding preference `byok`, `included`, or `auto` within operator policy.
- Provide bounded “test connection” with clear provider errors that never echo credentials.

Done when:

- Browser devtools/API responses after creation contain no stored plaintext credential.
- BYOK-only users can integrate even while no free-tier slot is available.

### 6. Build usage, request history, and playground

- Paginated/filterable usage by period, funding type, endpoint family, status, and latency.
- Privacy-aware request history: method, route family, timestamp, source class, status, duration, request ID; target URLs are redacted or reduced according to policy.
- Playground uses the same account policy and quota pipeline as external calls; it cannot bypass gateway tokens/quota through a trusted session shortcut.
- Display operation limits and whether a playground action consumes included quota before dispatch.

Done when:

- User history cannot request another account ID through URL/query manipulation.
- Playground charges exactly like the documented equivalent API request.

### 7. Build security and account settings

- Profile and verified email change flow.
- Password change with reauthentication.
- TOTP setup/disable/reset and recovery-code regeneration.
- Active session list, revoke-one, and log-out-all.
- Security event history.
- Account export/deletion request and retention explanation.
- User token-retention controls bounded by operator maxima; do not expose platform audit-retention configuration.

Done when:

- Sensitive actions require current credentials/MFA and produce security events/emails.
- Account deletion clearly identifies immediate versus retained data.

### 8. Update design and navigation

- Rename product terminology away from “Admin UI” and “hybrid gateway” where user-facing.
- User sidebar contains Dashboard, Endpoint, Tokens, BYOK Credentials, Usage, Playground, Security, and Account—never Users, infrastructure sources, global retention, or platform settings.
- Keep operator visual density distinct from the simpler user experience while sharing tokens/primitives.
- Preserve responsive behavior, reduced motion, focus management, and accessible dialogs.

Done when:

- `docs/DESIGN.md` documents public, user, and operator shells.
- Mobile and desktop navigation expose no unauthorized links.

## Verification

- Frontend unit/component tests for auth forms, one-time secrets, quota states, and destructive dialogs.
- Contract tests against API fixtures.
- Browser flows for registration -> verification -> login, token creation, BYOK setup, included request, exhaustion, security settings, and logout.
- Accessibility scan plus keyboard checks for public and app routes.
- Root lint/typecheck/test/build.

## Dependencies requiring approval

- React Testing Library/jsdom or equivalent component-test stack.
- Playwright for real-browser tests.
- Any form/query library; prefer React Router Data APIs and existing primitives unless evidence shows a need.
