# Native NestJS route matrix

This is the compatibility contract for the native Fastify/Nest runtime. It is checked against the native module controllers, the shipped web API clients, and the shared schemas in `packages/contracts/src/index.ts`.

`Native` means that the route is registered by a Nest controller. `Native-pending` identifies routes whose complete success-path contract evidence is still being expanded; it is not an Express runtime path.

## Conventions

- All JSON error responses use `errorEnvelopeSchema` where a shared schema exists; otherwise the established `{ success: false, error }` envelope is retained.
- `CSRF` applies to browser-session state changes after authentication. Gateway bearer-token requests are not browser-session mutations.
- `MFA` means verified MFA, and `step-up` means the recent sensitive-action verification required by the operator boundary.
- Body limits are per-route parser limits. Gateway limits retain the configured gateway ceiling (`maxBodyBytes`, currently 5 MiB in the server integration); streaming responses are not buffered except where fallback inspection requires bounded buffering.

## Core and public gateway

| Method | Path | Body | Access requirements | Response contract | Owner | Status / evidence |
|---|---|---:|---|---|---|---|
| GET | `/health` | — | public | `healthSchema` (`{status:"ok"}`) | `core` | Native; `test/e2e/health.e2e.test.ts` |
| GET | `/ready` | — | public; database readiness check | `healthSchema`; `503` when unavailable | `core` | Native; `test/e2e/health.e2e.test.ts` |
| POST | `/api/v1/webhooks/brevo` | 64 KiB | bearer webhook token; idempotent event ID | `{success:true}`; `202` | `email` | Native; `modules/webhooks/application/brevo-webhook.service.spec.ts`, `modules/webhooks/presentation/brevo-webhook.controller.spec.ts` |
| * | `/v1/*` | gateway ceiling | gateway bearer token, token scope/tenant policy, rate/quota policy | upstream status, filtered headers, streamed body; error envelope on gateway rejection | `gateway` | Native-pending; proxy and data-plane characterization tests |
| * | `/v2/*` | gateway ceiling | gateway bearer token, token scope/tenant policy, rate/quota policy | upstream status, filtered headers, streamed body; error envelope on gateway rejection | `gateway` | Native-pending; proxy and data-plane characterization tests |
| * | `/e/:endpointId/v1/*` | gateway ceiling | gateway bearer token, endpoint/account ownership, route policy | upstream status, filtered headers, streamed body; endpoint ID never forwarded | `gateway` | Native-pending; `test/e2e/health.e2e.test.ts`, gateway controller/policy/transport tests |
| * | `/e/:endpointId/v2/*` | gateway ceiling | gateway bearer token, endpoint/account ownership, route policy | upstream status, filtered headers, streamed body; endpoint ID never forwarded | `gateway` | Native-pending; `test/e2e/health.e2e.test.ts`, gateway controller/policy/transport tests |

Unsupported paths under these families remain `404`; endpoint IDs are public routing metadata only and are never sent upstream.

## Authentication and sessions

Both prefixes below expose the same controller contract.

| Method | Path (prefix = `/api/v1/auth` or `/admin/api/auth`) | Body | Access requirements | Response contract | Owner | Status / evidence |
|---|---|---:|---|---|---|---|
| POST | `${prefix}/login` | 32 KiB | public when auth is enabled | success envelope; authenticated branch uses `authenticatedUserResponseSchema`; MFA branch returns `mfa_required` | `auth` | Native; `test/e2e/auth.e2e.test.ts` |
| POST | `${prefix}/login/mfa` | 32 KiB | pending MFA session | `authenticatedUserResponseSchema` | `auth` | Native; native MFA test task |
| POST | `${prefix}/logout` | 32 KiB | session if present; CSRF for an authenticated browser mutation | `{success:true}` | `auth` | Native; native session test task |
| GET | `${prefix}/me` | — | authenticated session | `authenticatedUserResponseSchema` | `auth` | Native; `test/e2e/auth.e2e.test.ts` |
| GET | `${prefix}/csrf` | — | session; no mutation | `{data:{token:string}}` | `auth` | Native; native CSRF coverage |
| POST | `${prefix}/register` | 32 KiB | public; registration policy | generic success message | `auth` | Native-pending; `test/e2e/auth.e2e.test.ts`, native route contract test |
| POST | `${prefix}/verification/request` | 32 KiB | public; generic response/rate limit | generic success message | `auth` | Native-pending; `test/e2e/auth.e2e.test.ts`, native route contract test |
| POST | `${prefix}/verification/consume` | 32 KiB | public token | `{success:true}` | `auth` | Native-pending; `test/e2e/auth.e2e.test.ts`, native route contract test |
| POST | `${prefix}/password/forgot` | 32 KiB | public; generic response/rate limit | generic success message | `auth` | Native-pending; `test/e2e/auth.e2e.test.ts`, native route contract test |
| POST | `${prefix}/password/reset` | 32 KiB | public reset token | `{success:true}` | `auth` | Native-pending; `test/e2e/auth.e2e.test.ts`, native route contract test |
| POST | `${prefix}/email` | 32 KiB | authenticated; sensitive reauthentication; CSRF | generic success message or `409` | `auth` | Native; native auth controller |
| POST | `${prefix}/password` | 32 KiB | authenticated; sensitive reauthentication; CSRF | `{success:true}` | `auth` | Native; native auth controller |
| GET | `${prefix}/mfa` | — | authenticated | `mfaStateSchema` in `data` | `auth` | Native; web client consumer |
| POST | `${prefix}/mfa/setup` | 32 KiB | authenticated; sensitive reauthentication; CSRF | `mfaSetupSchema` in `data` | `auth` | Native; web client consumer |
| POST | `${prefix}/mfa/enable` | 32 KiB | authenticated; MFA code; CSRF | `recoveryCodesResponseSchema` | `auth` | Native; web client consumer |
| POST | `${prefix}/mfa/recovery-codes` | 32 KiB | authenticated; sensitive reauthentication; CSRF | `recoveryCodesResponseSchema` | `auth` | Native; web client consumer |
| POST | `${prefix}/mfa/disable` | 32 KiB | authenticated; sensitive reauthentication; CSRF | `{success:true}` | `auth` | Native; web client consumer |
| GET | `${prefix}/sessions` | — | authenticated | `sessionListSchema` in `data` | `auth` | Native; web client consumer |
| DELETE | `${prefix}/sessions/:id` | 32 KiB | authenticated; CSRF | `{success:true}` | `auth` | Native; native auth controller |
| POST | `${prefix}/sessions/revoke-all` | 32 KiB | authenticated; CSRF | `{success:true}` | `auth` | Native; `test/e2e/auth.e2e.test.ts` |

## User portal and gateway-token/credential APIs

| Method | Path | Body | Access requirements | Response contract | Owner | Status / evidence |
|---|---|---:|---|---|---|---|
| GET | `/api/v1/app/overview` | — | authenticated session | `portalOverviewSchema` in `data` | `portal` | Native-pending; `apps/web/src/features/portal/api.ts` |
| GET | `/api/v1/app/dashboard` | — | authenticated session | `portalOverviewSchema` in `data` | `portal` | Native-pending; web dashboard consumer |
| GET | `/api/v1/app/account` | — | authenticated session | `accountViewSchema` in `data` | `portal` | Native-pending; portal client |
| PATCH | `/api/v1/app/account` | 128 KiB | authenticated session; CSRF | `accountUpdateResponseSchema` in `data` | `portal` | Native-pending; portal client |
| POST | `/api/v1/app/account/export` | 128 KiB | authenticated; sensitive reauthentication; CSRF | `accountExportSchema` in `data` | `portal` | Native-pending; native route contract test |
| POST | `/api/v1/app/account/deletion-request` | 128 KiB | authenticated; sensitive reauthentication; CSRF | `deletionResponseSchema` in `data` | `portal` | Native-pending; native route contract test |
| GET | `/api/v1/app/endpoint` | — | authenticated session | `endpointViewSchema` in `data` | `portal` | Native-pending; portal client |
| GET | `/api/v1/app/quota` | — | authenticated session | `quotaSummarySchema` in `data` | `portal` | Native-pending; portal client |
| GET | `/api/v1/app/usage` | — | authenticated; bounded pagination/filter query | `usagePageSchema` in `data` | `portal` | Native-pending; portal client |
| GET | `/api/v1/app/request-history` | — | authenticated; bounded pagination/filter query | `historyPageSchema` in `data` | `portal` | Native-pending; portal client |
| GET | `/api/v1/app/security/events` | — | authenticated session | `securityEventListSchema` in `data` | `portal` | Native-pending; portal client |
| GET | `/api/v1/app/tokens` | — | authenticated session; own account | `gatewayTokenListSchema` in `data` | `gateway-tokens` | Native-pending; portal client |
| POST | `/api/v1/app/tokens` | 32 KiB | authenticated; verified email; sensitive reauthentication; CSRF | `gatewayTokenSchema` in `data`; plaintext only on creation | `gateway-tokens` | Native-pending; portal client |
| DELETE | `/api/v1/app/tokens/:id` | 32 KiB | authenticated owner; sensitive reauthentication; CSRF | `gatewayTokenSchema` in `data` | `gateway-tokens` | Native-pending; portal client |
| GET | `/api/v1/app/credentials` | — | authenticated; own account | `credentialMetadataListSchema` in `data` | `credentials` | Native-pending; portal client |
| POST | `/api/v1/app/credentials` | 32 KiB | authenticated; sensitive reauthentication; CSRF | `credentialMetadataSchema` in `data` | `credentials` | Native-pending; portal client |
| PUT | `/api/v1/app/credentials/:id` | 32 KiB | authenticated owner; sensitive reauthentication; CSRF | `credentialMetadataSchema` in `data` | `credentials` | Native-pending; portal client |
| POST | `/api/v1/app/credentials/:id/validate` | 32 KiB | authenticated owner; sensitive reauthentication; CSRF | `credentialMetadataSchema` in `data` | `credentials` | Native-pending; portal client |
| DELETE | `/api/v1/app/credentials/:id` | 32 KiB | authenticated owner; sensitive reauthentication; CSRF | `{success:true}` | `credentials` | Native-pending; portal client |
| * | `/api/v1/app/playground/v1/*`, `/api/v1/app/playground/v2/*` | gateway ceiling | authenticated browser session plus gateway bearer token; only v1/v2 suffixes | gateway response | `gateway` | Native-pending; native route contract test |
| * | `/admin/api/playground/v1/*`, `/admin/api/playground/v2/*` | gateway ceiling | authenticated browser session plus gateway bearer token; only v1/v2 suffixes | gateway response | `gateway` | Native-pending; native route contract test |

## Operator and retained legacy-admin compatibility routes

`/api/v1/admin` is the native operator boundary target. Mutations additionally require a non-empty reason, recent step-up, readiness, and an atomic audit record. `/admin/api` routes are retained only while shipped UI callers require them.

| Method | Path | Body | Access requirements | Response contract | Owner | Status / evidence |
|---|---|---:|---|---|---|---|
| POST | `/api/v1/admin/step-up` | 64 KiB | platform admin; verified MFA; CSRF | success envelope / step-up state | `operator` | Native-pending; `modules/operator/presentation/operator.guards.spec.ts`, native route contract test |
| GET | `/api/v1/admin/` | — | platform admin; verified MFA; readiness | bounded operator summary | `operator` | Native-pending; operator UI consumer |
| GET | `/api/v1/admin/capacity` | — | platform admin; verified MFA; readiness | quota policy/capacity data | `operator` / `quota` | Native-pending; operator UI consumer |
| GET | `/api/v1/admin/accounts` | — | platform admin; verified MFA; bounded query | account list | `accounts` | Native-pending; operator UI consumer |
| GET | `/api/v1/admin/accounts/:id` | — | platform admin; verified MFA | account detail | `accounts` | Native-pending; operator UI consumer |
| POST | `/api/v1/admin/accounts/:id/{suspend,block,reactivate,free-tier/revoke,sessions/revoke-all,tokens/revoke-all}` | 64 KiB | platform admin; verified MFA; recent step-up; reason; readiness; CSRF | established success/data envelope | owning feature | Native-pending; operator mutation tests |
| DELETE | `/api/v1/admin/accounts/:id` | 64 KiB | platform admin; verified MFA; recent step-up; reason; readiness; CSRF | established success/data envelope | `accounts` | Native-pending; operator mutation tests |
| GET | `/api/v1/admin/infrastructure` | — | platform admin; verified MFA; readiness | source list | `sources` | Native-pending; operator UI consumer |
| POST/PATCH | `/api/v1/admin/infrastructure[/:id]` | 64 KiB | platform admin; verified MFA; recent step-up; reason; readiness; CSRF | source record/envelope | `sources` | Native-pending; operator UI consumer |
| POST | `/api/v1/admin/infrastructure/:id/{test,activate,pause}` | 64 KiB | platform admin; verified MFA; recent step-up; reason; readiness; CSRF | source record/envelope | `sources` | Native-pending; operator UI consumer |
| GET | `/api/v1/admin/infrastructure/credentials` | — | platform admin; verified MFA; readiness | metadata-only credential list | `credentials` | Native-pending; operator UI consumer |
| POST/PUT/DELETE | `/api/v1/admin/infrastructure/credentials[/:id]` | 64 KiB | platform admin; verified MFA; recent step-up; reason; readiness; CSRF | metadata/envelope | `credentials` | Native-pending; operator UI consumer |
| GET | `/api/v1/admin/{usage,requests}` | — | platform admin; verified MFA; bounded query window | bounded analytics data | `operator` | Native-pending; operator UI consumer |
| GET | `/api/v1/admin/notifications` | — | platform admin; verified MFA | bounded notification list | `operator` | Native-pending; operator UI consumer |
| POST | `/api/v1/admin/notifications/:id/{acknowledge,resolve}` | 64 KiB | platform admin; verified MFA; recent step-up; reason; readiness; CSRF | notification record/envelope | `operator` | Native-pending; operator UI consumer |
| GET | `/api/v1/admin/security` | — | platform admin; verified MFA | bounded security data | `operator` | Native-pending; operator UI consumer |
| GET/PUT | `/api/v1/admin/configuration` | 64 KiB for PUT | platform admin; verified MFA; recent step-up + reason for PUT; readiness; CSRF | bounded settings data | `operator` | Native-pending; operator UI consumer |
| GET | `/admin/api/logs` | — | authenticated admin; verified MFA | audit log list | `audit` | Native-pending; native route contract test, web dashboard |
| DELETE | `/admin/api/logs/:id` | default JSON parser | authenticated admin; verified MFA; CSRF | success envelope | `audit` | Native-pending; native route contract test, web dashboard |
| DELETE | `/admin/api/logs` | default JSON parser | authenticated admin; verified MFA; CSRF | success envelope | `audit` | Native-pending; native route contract test, web dashboard |
| GET | `/admin/api/data` | — | authenticated admin; verified MFA | dashboard aggregate data | `operator` | Native-pending; native route contract test, web dashboard |
| GET | `/admin/api/users` | 32 KiB on mutations | authenticated admin; verified MFA; CSRF for mutations | user list/detail | `accounts` | Native-pending; native route contract test, web UI |
| POST/PATCH | `/admin/api/users[/:id]` | 32 KiB | authenticated admin; verified MFA; CSRF | user record | `accounts` | Native-pending; native route contract test |
| POST | `/admin/api/users/:id/{suspend,block,activate}` | 32 KiB | authenticated admin; verified MFA; CSRF | user record/envelope | `accounts` | Native-pending; native route contract test |
| DELETE | `/admin/api/users/:id` | 32 KiB | authenticated admin; verified MFA; CSRF | success/data envelope | `accounts` | Native-pending; native route contract test |
| GET/POST/DELETE | `/admin/api/api-keys[/:id]` | JSON parser | authenticated; reauthentication for mutations | gateway token list/record/envelope | `gateway-tokens` | Native-pending; native route contract test, web UI |
| GET/POST/PUT/DELETE | `/admin/api/credentials[/:id]` | 32 KiB for mutations | authenticated; sensitive reauthentication where required; CSRF | credential metadata/envelope | `credentials` | Native-pending; native route contract test |
| GET/PUT | `/admin/api/settings` | 32 KiB for PUT | authenticated admin; verified MFA; CSRF for PUT | persisted settings/credit usage | `operator` | Native-pending; native route contract test, web UI |
| GET/POST/PATCH/DELETE | `/admin/api/quota/...` | 32 KiB for mutations | authenticated admin; verified MFA; CSRF; operator reason on mutations | quota policy, enrollment, entitlement, event envelopes | `quota` | Native-pending; native route contract test |

## Static UI and negative-space rules

| Method | Path | Access / response | Owner | Status / evidence |
|---|---|---|---|---|
| GET | `/`, `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`, `/app`, `/app/*`, `/admin`, `/admin/*` | when auth is enabled, serve the built SPA document; when disabled, `/admin` routes return `404` with the established disabled envelope | `core` / `portal` / `operator` | Native-pending; `test/e2e/health.e2e.test.ts`, `modules/static-ui/static-ui.controller.spec.ts` |
| GET | `/api/*`, `/admin/api/*`, `/e/*`, `/health`, `/ready` | never fall through to the SPA document | owning API module or `core` | Legacy behavior; native negative-space smoke task |

The matrix is intentionally checked in before the compatibility window closes. A route may be marked `Native` only after a native Fastify contract test covers its method, path, access gates, body limit, and response shape. A route may be removed only after repository-wide caller evidence and an explicit compatibility decision are recorded.
