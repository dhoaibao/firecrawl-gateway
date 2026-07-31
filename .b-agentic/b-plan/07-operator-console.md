# Phase 7 — Operator Console, Notifications, and Analytics

Depends on: Phases 3–6
Audience: platform operators only; mandatory MFA and step-up authentication

## Scope

- Replace the current mixed admin dashboard with a dedicated `/admin/*` operator console.
- Manage accounts, permanent free-tier commitments, waitlist, infrastructure sources, policy, notifications, privacy, and security.
- Deliver capacity/source/security alerts in-app and through Brevo.
- Replace last-500 in-memory analytics with database-backed bounded aggregate queries.

## Operator navigation

```text
/admin
/admin/capacity
/admin/accounts
/admin/waitlist
/admin/infrastructure
/admin/usage
/admin/requests
/admin/notifications
/admin/security
/admin/configuration
```

Use “Accounts” rather than the current user-creation-oriented “Users” page. Identity details, tenant resources, quota commitments, and actions belong in an account detail view.

## Steps

### 1. Create an isolated operator route/API boundary

- Mount operator APIs only under `/api/v1/admin/*` with authentication, active operator role, completed MFA, CSRF, and step-up checks for high-risk mutations.
- Add a distinct operator React layout/navigation and route-level authorization loader.
- Audit every operator read/write with actor, reason, request ID, and bounded before/after metadata.
- Return no credential plaintext, password/auth material, or unredacted sensitive target data.

Done when:

- An authenticated ordinary user cannot access operator data by direct API or URL navigation.
- Stale sessions after role removal/MFA reset fail immediately through `auth_version`/session checks.

### 2. Build the capacity control center

Display:

- Permanent commitment ceiling and committed amount.
- Current-period allocated/reserved/consumed/hard-cap values.
- Remaining permanent 100-request slots.
- Suspended committed seats and current-month skipped allocation.
- Waitlist size and admission forecast.
- Projected exhaustion and source capacity pressure.

Controls:

- Change future default grant.
- Set/schedule commitment and hard usage ceilings.
- Pause new grants or included traffic.
- Preview impact before save.
- Manually adjust an account through ledger entries.
- Process waitlist automatically/manually.

Done when:

- Impossible changes are rejected server-side even if UI validation is bypassed.
- Every mutation requires reason/confirmation and shows resulting invariant values.

### 3. Build infrastructure-source management

- List self-hosted and operator Cloud sources with status, capability, priority, budget, consumed, concurrency, latency, and health.
- Add/edit/test/pause/drain sources.
- Add/replace/revoke operator provider credentials with one-time input and permanent masking.
- Configure source ordering/fallback and operation allowlists.
- Show provider credit/budget data as advisory; only explicit operator configuration changes promised capacity.
- Provide emergency per-source and global included-traffic cutoffs.

Done when:

- Source tests are bounded, audited, and secret-redacted.
- Draining stops new jobs while allowing sticky existing jobs to poll/cancel.
- Adding a source does not silently increase permanent commitments.

### 4. Replace user management with account operations

- Search/filter accounts by verification, active/suspended/blocked status, enrollment/waitlist state, usage, and creation date.
- Account detail: identity/membership, endpoint, token metadata, masked BYOK status, entitlements, usage, sessions/security events, and operator audit.
- Actions: suspend, block, reactivate, revoke free-tier eligibility, re-enroll/waitlist, revoke gateway tokens/sessions, adjust quota, and process deletion.
- Protect self-actions and last-operator scenarios; require stronger confirmation for role/free-tier/data deletion changes.

Done when:

- Suspension blocks all session and data-plane access immediately but does not release the permanent slot.
- Free-tier revocation releases the commitment exactly once and leaves BYOK eligibility according to account policy.

### 5. Build database-backed analytics

Create bounded aggregate/query services for:

- Requests over time by included/BYOK, source, route family, status, and fallback.
- Commitment/allocation/utilization and unused allowances.
- Active/enrolled/waitlisted/suspended account cohorts.
- Source latency, health, errors, concurrency saturation, and budget burn.
- Highest-usage accounts with operator authorization and reasoned access.
- Email delivery and auth/security event health.

Use indexed time ranges, pagination/keyset pagination, pre-aggregated daily/hourly tables when measurements require them, and explicit retention. Do not load all logs and aggregate in Node.

Done when:

- Analytics query plans remain bounded on representative data volumes.
- Aggregates reconcile to quota/usage ledgers within documented eventual-consistency bounds.

### 6. Implement notification center and delivery

- Store notification type, severity, deduplication key, state, first/last occurrence, period/source/account references, and acknowledgement.
- Render persistent banners for active critical capacity/source/security conditions.
- Operator preferences choose in-app/email destinations and thresholds within safe defaults.
- Brevo outbox delivers capacity, hard-cap, source-down, credential-low/invalid, waitlist-growth, migration, and security alerts.
- Support acknowledge, resolve, and recurrence; never suppress a higher threshold because a lower one was acknowledged.

Done when:

- Threshold storms produce deduplicated notifications and bounded email volume.
- Failed email delivery remains visible in-app.
- Notification payloads contain no secrets or customer target URLs.

### 7. Rehome configuration and retention

Operator-only configuration includes:

- Registration mode and abuse controls.
- Default grants, ceilings, thresholds, source policy, and operation limits.
- Brevo sender/template IDs and notification preferences; API key remains deployment secret.
- Session/auth policy bounds.
- Request/security/audit/email retention and redaction.
- Maximum user-configurable token expiry/inactivity values.

Remove current automatic user-inactivity suspension. User-specific token expiry remains in the user portal under operator bounds.

Done when:

- Configuration has typed schemas, versioning, actor/reason audit, and safe defaults.
- Secret values cannot be inserted into generic settings fields.

### 8. Add operator safety UX

- Require recent password+MFA step-up for source credentials, capacity reductions, role changes, free-tier revocation, and deletions.
- Use preview/dry-run APIs for capacity and bulk actions.
- Add typed confirmations for irreversible operations.
- Present UTC period boundaries explicitly.
- Provide read-only mode when schema/version/readiness is degraded.

Done when:

- Browser tests prove confirmations cannot bypass server invariants.
- Emergency controls are available and clearly distinguished from routine configuration.

## Verification

- Operator authorization and step-up integration suite.
- Capacity/source/account mutation tests including forged ordinary-user calls.
- Analytics reconciliation and query-plan checks on seeded representative data.
- Notification deduplication, threshold, acknowledgement, retry, and delivery tests.
- Browser coverage for capacity changes, source management, suspension/reactivation, free-tier revocation, and waitlist admission.
- Accessibility and responsive checks on data-dense screens.
