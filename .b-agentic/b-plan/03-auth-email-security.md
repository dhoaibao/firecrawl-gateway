# Phase 3 — Authentication, Brevo Email, Sessions, and 2FA

Depends on: Phase 2
Release posture: registration remains closed or invite-only until Phase 5 capacity admission is active

## Scope

- Add registration and verified-email lifecycle.
- Add password reset and secure account changes.
- Add TOTP 2FA, recovery codes, and mandatory operator MFA.
- Add session inventory/revocation and CSRF protection.
- Integrate Brevo through a durable PostgreSQL outbox and delivery webhooks.
- Remove inactivity-based account suspension; suspension becomes an explicit operator/security action.

## Auth data

- `users`: normalized email, `email_verified_at`, platform role, status, password/auth version.
- `auth_tokens`: purpose, user, token hash, expiry, consumed timestamp; never store plaintext verification/reset tokens.
- `mfa_factors`: encrypted TOTP secret, key version, verified/enabled timestamps.
- `mfa_recovery_codes`: individually hashed, single-use codes.
- `auth_sessions`: user-visible metadata and revocation state associated with server-side sessions; never expose raw session IDs.
- `security_events`: append-only login, password, email, MFA, session, and suspension events with privacy-bounded metadata.
- `email_outbox` and `email_delivery_events`: durable intent and provider status.

## Steps

### 1. Refactor authentication into explicit services

- Keep Passport Local and PostgreSQL-backed server sessions initially; do not write a custom token authentication system for the web portal.
- Split credential verification, account access policy, session lifecycle, CSRF, and route handlers.
- Normalize emails before every lookup.
- Return generic login/registration/reset responses that do not disclose account existence or suspension details.
- Rehash bcrypt passwords on successful login when configured cost increases.
- Fail production startup when session or encryption secrets are missing/invalid.

Done when:

- Login behavior is timing/response-shape tested for existing, missing, suspended, and wrong-password accounts.
- No route returns `password_hash`, TOTP material, recovery hashes, token hashes, or session identifiers.

### 2. Implement registration and email verification

- Add `POST /api/v1/auth/register`, verification-request, and verification-consume endpoints.
- Apply per-IP and per-normalized-email throttles, body limits, and optional challenge hook before creating email work.
- Use cryptographically random verification tokens, store only hashes, set short expiry, and make consumption single-use and transactional.
- Create the personal account/membership from Phase 2 as part of registration.
- Keep the account unverified and unable to use gateway tokens until verification.
- On successful verification, call a `FreeTierAdmissionService`; until Phase 5 is complete, registration stays closed/invite-only so no account bypasses capacity admission.

Done when:

- Duplicate registration produces a generic response and no duplicate user/account.
- Verification replay, expiry, and concurrent consumption tests pass.
- No free-tier entitlement can be created solely by setting `email_verified_at` outside the admission service.

### 3. Apply modern password policy and recovery

- Support long passphrases (maximum at least 128), all characters, and no composition rules.
- Use a minimum consistent with single-factor guidance while MFA remains optional; document the final UX policy before implementation.
- Add breached/common-password screening through an approved privacy-preserving mechanism or local list.
- Add forgot/reset endpoints with generic responses, random hash-only single-use tokens, rate limits, and expiry.
- On reset, increment `auth_version`, invalidate existing sessions, and send a security notification.
- Require current password plus active MFA for password/email changes from an authenticated session.

Done when:

- Reset requests cannot enumerate users.
- Token replay and race tests prove only one reset succeeds.
- Password reset and email change invalidate all prior sessions and gateway-management CSRF state.

### 4. Add session security and CSRF

- Use a production `__Host-` session cookie where HTTPS permits: Secure, HttpOnly, no Domain, Path `/`, and SameSite Lax or Strict based on verified flows.
- Add server-side idle and absolute timeouts rather than relying only on cookie max-age.
- Regenerate session IDs after login, MFA completion, password reset, role change, and other privilege changes.
- Add session inventory with created/last-seen timestamps and bounded device/IP labels; store privacy-minimized values.
- Support revoke-one and log-out-all. Logout destroys server state and clears browser state.
- Add a session-bound CSRF synchronizer token/custom header for every state-changing cookie-authenticated route, plus Origin validation and exact credentialed CORS allowlists.

Done when:

- Cross-origin state-changing requests fail even if a browser sends the session cookie.
- Revoked, idle-expired, absolute-expired, and auth-version-invalid sessions cannot be reused.
- Session IDs and CSRF tokens are absent from logs.

### 5. Add TOTP 2FA and recovery

- Select an approved, maintained RFC-compatible TOTP library; do not implement TOTP primitives manually.
- Setup flow: generate encrypted pending secret -> show QR/manual key once -> require valid code -> enable factor.
- Apply strict per-account/IP attempt limits and reject reused codes within the accepted time window.
- Generate a configurable set of random recovery codes; display once and store individual hashes.
- Require current password and an existing factor/recovery code to disable or replace MFA.
- Notify the user out of band on factor enable/disable/reset.
- Require verified TOTP for every operator account before operator routes are usable; provide a documented break-glass recovery procedure.

Done when:

- Pending factors cannot authenticate.
- TOTP replay, attempt-limit, clock-window, recovery-code single-use, and concurrent recovery tests pass.
- Operator APIs reject password-only sessions.

### 6. Integrate Brevo through an outbox

- Keep `BREVO_API_KEY` in deployment secrets only. Store sender identity, template IDs, and notification preferences as validated non-secret configuration.
- In the same database transaction that creates an auth token/security event, insert an `email_outbox` row with a stable idempotency key.
- Worker claims rows with `FOR UPDATE SKIP LOCKED`, sends `POST /v3/smtp/email`, records Brevo message ID, and retries transient/429 failures with bounded exponential backoff and jitter.
- Dead-letter permanent failures and expose them to operators.
- Add a bearer-protected Brevo webhook endpoint; deduplicate events and update delivery status without trusting payload identity alone.
- Never put plaintext reset/verification tokens in persistent outbox payloads longer than needed. Prefer rendering a one-time URL at enqueue time into encrypted/short-retention payload or an equivalent secure design documented before implementation.

Done when:

- Database commit without worker availability still results in eventual email delivery.
- Worker retries do not send duplicate logical emails.
- Invalid webhook authentication and duplicate webhook events are rejected/ignored safely.
- Brevo rate-limit headers and `429` are honored.

### 7. Remove incompatible inactivity behavior

- Delete the automatic user inactivity suspension job and its operator setting.
- Replace automatic gateway-token revocation with user-configurable token expiry/inactivity settings bounded by operator maximums.
- Preserve explicit suspended/blocked access checks in every session and data-plane path.

Done when:

- Inactivity alone never suspends an account or removes its permanent future free-tier slot.
- Suspended users cannot log in, use gateway tokens, or consume included/BYOK routes.

## Verification

- Unit tests for token hashing/expiry, policy, TOTP, recovery, and CSRF.
- Real-PostgreSQL integration tests for token races, outbox claims, session revocation, and security events.
- Route tests for generic responses and throttles.
- Brevo adapter contract tests using a local fake HTTP server; no real email during CI.
- Browser tests for registration, verification landing, login+TOTP, reset, and session management in Phase 8.

## Approvals needed before implementation

- TOTP and password-screening dependency choices.
- Brevo API access or real-email tests.
- Auth schema migrations and session-cookie production changes.
