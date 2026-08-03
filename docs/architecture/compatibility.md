# Phase 1 compatibility surface

This table records the externally observable gateway surface preserved by the repository restructure.

| Area | Current contract |
| --- | --- |
| Health | `GET /health` returns `{ "status": "ok" }`; `GET /ready` returns `200` with database `ok` or `503` with database `error`. |
| Admin availability | With `AUTH_ENABLED=false`, `/admin` and `/admin/*` return `404` and the established disabled message. With auth enabled, `/admin` serves the SPA and `/admin/api/*` remains API-only. |
| API proxy | Only `/v1/*` and `/v2/*` are proxied. Other paths return the established `success: false` 404 envelope. |
| Auth routes | `/admin/api/auth/login`, `/logout`, `/me`, and `/password` retain their methods and response envelopes. |
| Control-plane routes | Admin logs/data, users, API keys, settings, and playground routes retain their existing prefixes and authorization middleware. |
| Proxy headers | Responses retain `x-hybrid-firecrawl-backend`, `x-hybrid-firecrawl-fallback`, and optional `x-hybrid-firecrawl-fallback-reason`; rate-limited requests retain `X-RateLimit-*` headers. |
| Settings keys | `self_hosted_firecrawl_url`, `default_route_mode`, `firecrawl_api_keys`, `api_key_inactivity_revoke_days`, and `user_inactivity_suspend_days` remain persisted keys. Fresh databases use the checked-in Prisma migration and security bootstrap. |
| Environment | `PORT`, `GATEWAY_*`, `AUTH_ENABLED`, `DATABASE_URL`, `OPERATOR_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `SESSION_SECRET`, `FIRECRAWL_KEYS_ENCRYPTION_KEY`, `ADMIN_*`, `TRUST_PROXY`, `CORS_ORIGIN`, `SESSION_SECURE`, `BCRYPT_ROUNDS`, and `LOG_LEVEL` remain deployment inputs. |
| Persistence | PostgreSQL tables remain `users`, `api_keys`, `audit_logs`, `settings`, and `sessions`, accessed through Prisma. Audit JSONL remains configurable through `GATEWAY_LOG_FILE`. |
| Container | The source Compose deployment still exposes container port `8080`, runs the gateway as the non-root `gateway` user, and starts `apps/api/dist/main.js`; the worker starts `apps/api/dist/worker-main.js`. |

The route-composition tests in `apps/api/src/app.test.ts` cover the most important app-boundary behaviors; existing route and proxy tests remain characterization coverage for the rest.
