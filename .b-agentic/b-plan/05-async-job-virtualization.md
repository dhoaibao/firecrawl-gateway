# Async Job Virtualization (v1 and v2)

## Goal

Prevent tenant clients from learning upstream asynchronous job/session IDs or using them across accounts or infrastructure sources. Tenant routes return gateway-owned public IDs; the gateway maps them to upstream IDs and dispatches lifecycle requests through the original source and credential.

## Scope

- Tenant routes only: `/e/:endpointId/...`.
- Versions: both `/v1` and `/v2`.
- Resources: crawl, batch scrape, scrape jobs and scrape interaction, and documented interact-session routes.
- Preserve normal streaming for all non-async requests.
- Do not run migrations, conversion commands, or external source validation.

## Existing building blocks

- `apps/api/src/jobs/gateway-jobs.ts` provides account-scoped persistence.
- `apps/api/src/jobs/routes.ts` classifies creation/lifecycle paths and rewrites lifecycle IDs.
- `apps/api/src/jobs/virtualize.ts` rewrites a buffered creation response's top-level `id` and `url`.
- `apps/api/src/proxy.ts` chooses sources and already owns fallback/streaming behavior.

## Plan

1. **Expose selected-source provenance from proxy attempts**
   - Extend the internal proxy attempt result with selected source ID, credential ID, and funding type.
   - Preserve the final successful attempt's provenance after Cloud-key retries or backend fallback.
   - **Done when:** a successful tenant dispatch identifies the concrete source used without inferring it from route mode.

2. **Classify tenant async requests before dispatch**
   - Call `classifyAsyncRoute(req.method, parsedUrl.pathname)` only after gateway-token authentication and endpoint ownership checks.
   - For lifecycle requests, load the public ID through `getGatewayJob(accountId, publicId)`.
   - Return the same opaque 404 for missing and cross-account IDs; verify the stored route family matches the requested family.
   - Rewrite the upstream path with `replaceAsyncRouteId` before constructing upstream URLs.
   - **Done when:** lifecycle upstream requests receive only the stored upstream ID, never the public ID.

3. **Pin lifecycle dispatch**
   - Resolve tenant sources as usual, then require the recorded source ID and, when present, credential ID.
   - Do not use legacy-settings fallback, Cloud-key rotation, or self-hosted/Cloud fallback for a lifecycle request.
   - Return a controlled unavailable response when the recorded source is disabled or no longer resolvable.
   - **Done when:** poll, cancel, and interaction requests cannot switch infrastructure source or credential.

4. **Persist and rewrite creation responses**
   - Add a `bufferSuccess` proxy-attempt option used only for classified tenant async creations, including any eligible fallback attempt.
   - On a successful buffered response, call `virtualizeCreationResponse` with a newly generated public ID and tenant gateway URL.
   - Persist `createGatewayJob` before returning the rewritten response, including final source provenance and bounded creation-request diagnostics.
   - If response parsing or persistence fails, return a gateway error without forwarding an unowned upstream ID.
   - **Done when:** tenant creation responses expose public IDs/URLs only and every returned ID has an account-scoped mapping.

5. **Completion and response behavior**
   - Mark mappings complete after successful cancellation; mark terminal poll responses complete only when a bounded buffered status response safely identifies a terminal state.
   - Retain streaming for non-async traffic and avoid buffering large async result payloads solely for completion bookkeeping.
   - **Done when:** normal proxy streaming tests remain unchanged and cancellation records completion.

6. **Tests and documentation**
   - Add proxy integration coverage for v1 and v2 create, poll, cancel, scrape interaction, and interact sessions.
   - Cover public-ID/URL rewriting, opaque cross-account and unknown responses, source pinning, disabled pinned source, fallback suppression, and persistence failure.
   - Update `apps/api/README.md` with tenant async-ID semantics and lifecycle URL requirements.
   - **Done when:** `npm run api:typecheck`, `npm run api:test`, `npm run api:build`, and `git diff --check` pass.

## Implementation approval

Approved by the user: implement tenant async-job virtualization for v1 and v2.
