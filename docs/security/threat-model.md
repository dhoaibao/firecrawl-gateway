# Gateway threat model

## Assets and trust boundaries

Assets are account membership and quota state, gateway tokens, provider
credentials, sessions/MFA material, audit/security events, and target request
metadata. The browser crosses the session/CSRF boundary; public clients cross
the bearer-token boundary; the API crosses separate runtime/operator database
roles; and the gateway crosses the upstream provider boundary.

Threat actors include unauthenticated internet clients, compromised user tokens,
compromised accounts, malicious tenants, SSRF targets, and compromised
operators or deployment credentials.

## Required controls

| Threat | Control and verification |
| --- | --- |
| Enumeration, credential stuffing, reset abuse | Opaque auth responses, bounded auth rate limits, password/MFA tests, email outbox monitoring |
| Session fixation, CSRF, recovery abuse | Regenerated sessions, bounded request IDs, strict Origin plus CSRF token checks, MFA recovery and revocation tests |
| Object authorization and operator escalation | Account predicates/RLS, operator MFA/step-up/reason/audit middleware, cross-tenant negative tests |
| Token or provider-key theft | Hash gateway tokens, envelope-encrypt provider values, one-time secret responses, redacted logs and rotation drill |
| Quota race/replay/amplification | Server-owned quota IDs, transactional reservations/unique request IDs, concurrency and fault-injection tests |
| SSRF and DNS rebinding | Private-target policy, source URL validation, bounded redirects/timeouts/response buffers, source health/drain controls |
| Webhook abuse | Bounded JSON body, webhook secret, idempotent event handling, replay tests |
| Privacy leakage | No query strings in operational logs, target URLs redacted before audit persistence, retention/export/deletion review |
| Container/deployment compromise | Immutable image commands, non-root runtime, read-only root, dropped capabilities, migration-only credential, approved production environment |

## Pre-registration review

Run dependency review, package audit, secret scanning, static analysis, the
RLS/tenant suite, quota concurrency suite, route tests with fake providers, and
browser/accessibility checks. Review all high-risk findings manually. A missing
distributed rate-limit backend, missing provider-specific SSRF egress control,
or untested backup restore is a production blocker rather than an accepted
assumption.

Break-glass operator recovery is out of band, requires an approved change
window, removes no plaintext MFA material, revokes sessions, forces MFA
enrollment, and records a security event. Credential compromise requires
immediate token/session revocation, provider-key rotation, and preservation of
relevant audit records.
