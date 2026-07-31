# Phase 4 — Tenant Data Plane, Credentials, and Infrastructure Routing

Depends on: Phase 2; Phase 3 account-status interfaces
Release posture: new tenant endpoint feature-flagged until Phase 5 quota enforcement

## Scope

- Add `https://host/e/:endpointId/v1/*` and `/v2/*` tenant base URLs.
- Separate gateway authentication tokens from upstream provider credentials.
- Model user BYOK credentials and operator infrastructure sources.
- Decompose the current proxy into an auditable request pipeline.
- Preserve Firecrawl streaming, fallback, privacy checks, and old-route compatibility.
- Make async jobs sticky to their creation source and credential.

## Credential and source model

### Gateway tokens

- Tenant-owned, scoped, revocable, optionally expiring.
- Store only a strong hash, prefix, creation/last-use/expiry metadata, and scopes.
- Plaintext returned exactly once.
- Existing `api_keys.key_hash` values can remain valid during migration; remove/deprecate encrypted `key_value` after users have a safe transition.

### Provider credentials

- Account-owned Firecrawl Cloud BYOK credentials or operator-owned Cloud credentials.
- AES-256-GCM encrypted with purpose/account/source bound as authenticated data.
- Store key version, masked prefix/suffix, validation status, last validated/used timestamps, and provider metadata.
- Never return plaintext after creation; replacement creates a new credential version.

### Infrastructure sources

- Operator Cloud source backed by one or more operator credentials.
- Operator self-hosted source backed by a validated base URL and optional upstream auth.
- Status (`active`, `draining`, `paused`, `unhealthy`), priority, operation capabilities, monthly budget, hard concurrency, timeouts, and health state.
- Account BYOK is a funding/source candidate but never part of the shared operator capacity commitment.

## Steps

### 1. Define the data-plane contract

- Base URL is `/e/:endpointId`; clients append supported Firecrawl `/v1/*` or `/v2/*` paths.
- Require `Authorization: Bearer <gateway-token>`. The endpoint ID is public routing identity, not a secret.
- Require token account to match endpoint account.
- Define funding preference per account/endpoint: `byok`, `included`, or `auto`, bounded by operator policy.
- Strip only the validated `/e/:endpointId` prefix before forwarding.
- Publish consistent quota/routing response headers without exposing source secrets or private URLs.

Done when:

- Contract tests prove endpoint-ID-only requests fail.
- Cross-account endpoint/token combinations fail without revealing whether either resource exists.
- Firecrawl SDK/custom-base-URL smoke tests reach both `/v1` and `/v2` routes.

### 2. Migrate gateway tokens to hash-only storage

- Rename the product concept and module from API keys to gateway tokens.
- Preserve existing hashes and token authentication during compatibility.
- Stop decrypting/redisplaying existing token values; show prefix and metadata only.
- Add token scopes, expiry, user-controlled inactivity expiry, and last-use debouncing.
- After a communicated transition, remove encrypted token values and legacy crypto calls.

Done when:

- New plaintext tokens are observable once in creation response and never again.
- Database compromise does not reveal usable gateway token plaintext.
- Existing tokens continue authenticating until revoked/expired.

### 3. Add provider credential vault behavior

- Create account and operator credential repositories with explicit ownership.
- Extend current AES-GCM format with key version and authenticated context; support old ciphertext read during migration.
- Add `credential:rotate`/reencryption operational command before key rotation is needed.
- Validate a credential through a bounded provider health call without logging it.
- Keep Brevo, session, and provider encryption secrets separate.

Done when:

- Ciphertext moved between accounts/purposes fails authentication.
- Rotation can read old versions and writes only the current version.
- API/UI only return masks and health metadata.

### 4. Convert shared settings into infrastructure sources

- Convert `self_hosted_firecrawl_url` to a self-hosted source.
- Convert each existing encrypted operator Cloud key into its own credential/source association through an approved one-time application migration; SQL alone cannot safely decrypt current ciphertext.
- Keep legacy setting reads as fallback during a dual-read window, then remove them.
- Add source capability, priority, budget, timeout, and concurrency configuration.
- Source URLs must be operator-only, normalized, HTTPS in production unless explicitly approved, and protected against private-control-plane targets.

Done when:

- Existing routing produces equivalent source selection after conversion.
- Conversion is idempotent, reports counts/masks only, and never prints plaintext credentials.

### 5. Decompose the proxy request pipeline

Implement explicit stages with structured outcomes:

1. Resolve endpoint and authenticate gateway token.
2. Check account/user status and token scopes.
3. Parse/bound request body and supported path.
4. Enforce operation-specific limits and target/privacy policy.
5. Resolve funding preference and candidate source set.
6. Reserve included quota through a Phase 5 interface (feature-disabled until real enforcement exists).
7. Acquire source concurrency and choose credential.
8. Dispatch with sanitized headers and stripped URL.
9. Apply allowed fallback/retry without changing client-request count.
10. Finalize quota and append privacy-bounded usage/audit event.
11. Stream/buffer response as current behavior requires.

Replace the current monolithic proxy function with pure policy functions plus transport adapters. Keep successful response streaming.

Done when:

- Every rejection/fallback path has a typed outcome and audit reason.
- Quota and source-concurrency release occurs on every pre-dispatch failure.
- Existing proxy regression tests remain green and new tenant-path tests cover all stages.

### 6. Enforce operation and egress safeguards

Raw request quota does not represent actual Firecrawl cost. Add operator limits per route family:

- Maximum body/string/array sizes.
- Crawl/batch page counts and depth.
- Browser/interact TTL and concurrent jobs.
- Request timeout and response buffering ceiling.
- Allowed schemes and URL validation.
- Source-level network isolation/egress protection against loopback, link-local, metadata, and private management networks.

Do not claim gateway-only URL checks completely solve SSRF; self-hosted Firecrawl deployment must enforce network controls.

Done when:

- Oversized/over-depth/forbidden requests are rejected before quota dispatch.
- DNS rebinding/private-address threat cases are covered at the infrastructure boundary or documented as deployment blockers.

### 7. Add sticky async-job ownership

- Record account, public/upstream job ID, route family, source, credential reference, funding type, creation request, and lifecycle timestamps for async crawl/batch/browser jobs.
- Resolve status/cancel/errors through this mapping rather than selecting a new source.
- Enforce account ownership and handle credential rotation/revocation policy explicitly.
- Store only required upstream identifiers; never leak operator source URLs/keys.

Done when:

- Account A cannot poll/cancel Account B's job.
- A job created on source X continues status/cancel on X after priorities change.
- Job creation counts once; polling policy is explicitly tested as counted or uncounted according to the final route matrix.

### 8. Preserve and deprecate old routes

- Keep old root `/v1/*` and `/v2/*` token-auth routes during migration by resolving account from the legacy token.
- Add deprecation headers/documentation and endpoint migration examples.
- Do not allow new accounts to create legacy-only integrations after the tenant endpoint is stable.

Done when:

- Existing clients remain operational through the documented window.
- Usage events identify legacy route traffic so removal can be evidence-based.

## Verification

- Unit policy matrix for route/funding/source/fallback/privacy combinations.
- Real-PostgreSQL credential ownership and async-job isolation tests.
- Fake Cloud/self-hosted upstream integration tests including streaming, retry, timeout, and 429.
- SDK/custom-base-URL smoke tests.
- Secret-redaction assertions over responses and captured logs.

## Approvals needed before implementation

- One-time conversion of existing encrypted settings.
- Encryption-key format/rotation changes.
- External health checks or self-hosted source mutations.
