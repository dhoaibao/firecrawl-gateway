# Authentication security

## Passwords

Passwords accept every character, including spaces, and support passphrases from 12 through 128 characters. There are no composition rules. A small local common-password deny-list rejects obvious passwords. Passwords are bcrypt-hashed and successful logins rehash when `BCRYPT_ROUNDS` increases.

## Registration and email

Registration is closed unless `REGISTRATION_ENABLED=true`; this remains the default until capacity admission is available. Verification and reset responses are intentionally generic. Verification/reset tokens are random, short-lived, single-use SHA-256 hashes in PostgreSQL. Links always use the configured canonical `PUBLIC_APP_URL`, never the request Host header. Email payloads in the outbox are encrypted with `AUTH_ENCRYPTION_KEY`.

## Operator MFA

Operator/admin routes require a verified TOTP factor. A bootstrap admin may sign in to reach the MFA setup endpoint, then must scan the one-time secret, confirm a code, and store the displayed recovery codes offline. Recovery codes are individually hashed and single-use.

Break-glass recovery requires out-of-band operator identity verification, a deployment-approved change window, and an audited database operation by the operator credential to remove the lost factor and increment the account auth version. Revoke all sessions afterward, require immediate MFA re-enrollment, and record the incident/security event. Never request or record a plaintext TOTP secret or recovery code.

## Sessions and CSRF

Production sessions use a Secure, HttpOnly `__Host-` cookie with SameSite Lax, server-side idle/absolute expiry, auth-version checks, and a revocable session inventory. Operator routes additionally require an MFA assertion recorded for that specific server-side session. State-changing cookie-authenticated requests require the session-bound `X-CSRF-Token` header and same-origin or configured exact Origin.

## Brevo

`BREVO_API_KEY` and `BREVO_WEBHOOK_TOKEN` are deployment secrets. The durable outbox claims work with `FOR UPDATE SKIP LOCKED`, sends idempotent logical messages, retries transient/429 responses with bounded backoff, and dead-letters permanent failures. Webhook events require bearer authentication and are deduplicated.
