# NestJS cutover deletion checklist (temporary)

Phase 1 inventory only. Do not delete these paths until their native owner has a contract test and the final cutover phase is approved.

## Express composition and runtime

- [ ] `apps/api/src/app.ts`
- [ ] `apps/api/src/server.ts`
- [ ] `apps/api/src/app.test.ts`
- [ ] `apps/api/src/infrastructure/http/async-handler.ts`
- [ ] `apps/api/src/infrastructure/http/error-handler.ts`
- [ ] `apps/api/src/infrastructure/database/session-store.ts`
- [ ] `apps/api/src/middleware.ts`
- [ ] `apps/api/src/logger.ts` (remove only the Express request type; retain shared logger behavior if still used)

## Legacy route composition and controllers

- [ ] `apps/api/src/admin-api.ts`
- [ ] `apps/api/src/admin-api.controllers.ts`
- [ ] `apps/api/src/admin-api.test.ts`
- [ ] `apps/api/src/app-api.ts`
- [ ] `apps/api/src/app-api.test.ts`
- [ ] `apps/api/src/operator-api.ts`
- [ ] `apps/api/src/operator-api.test.ts`
- [ ] `apps/api/src/operator-audit.ts`
- [ ] `apps/api/src/api-keys/routes.ts`
- [ ] `apps/api/src/api-keys/routes.test.ts`
- [ ] `apps/api/src/api-keys/controllers.ts` (retain service/repository only where native code uses them)
- [ ] `apps/api/src/auth/routes.ts`
- [ ] `apps/api/src/auth/routes.test.ts`
- [ ] `apps/api/src/auth/middleware.ts`
- [ ] `apps/api/src/auth/middleware.test.ts`
- [ ] `apps/api/src/auth/email.ts` (split into native `EmailModule` first)
- [ ] `apps/api/src/auth/session.ts`
- [ ] `apps/api/src/credentials/routes.ts`
- [ ] `apps/api/src/credentials/routes.test.ts`
- [ ] `apps/api/src/quota/routes.ts`
- [ ] `apps/api/src/quota/routes.test.ts`
- [ ] `apps/api/src/settings/routes.ts`
- [ ] `apps/api/src/settings/routes.test.ts`
- [ ] `apps/api/src/users/routes.ts`
- [ ] `apps/api/src/users/routes.test.ts`
- [ ] `apps/api/src/users/controllers.ts`

## Legacy gateway and compatibility tests

- [ ] `apps/api/src/proxy.ts`
- [ ] `apps/api/src/proxy.test.ts`
- [ ] `apps/api/src/proxy.integration.test.ts`
- [ ] `apps/api/src/proxy-quota.test.ts`
- [ ] `apps/api/src/data-plane.test.ts`
- [ ] `apps/api/src/playground.test.ts`

## Express-only package surface

- [ ] dependencies: `express`, `express-session`, `compression`, `cors`, `helmet`, `passport`, `passport-local`
- [ ] dev dependencies: `@types/express`, `@types/express-session`, `@types/passport`, `@types/passport-local`, `@types/compression`, `@types/cors`, `supertest`
- [ ] scripts and entrypoints referring to `dist/server.js` or `src/server.ts`

## Exit evidence required before checking items off

- [ ] `rg` finds no runtime or test imports of Express, Passport, or `express-session`.
- [ ] Native Fastify contract tests cover every row in `docs/architecture/nest-route-matrix.md`.
- [ ] Package lock changes are limited to approved dependency removals.
- [ ] Final `git diff --check`, API/web verification gates, and changed-code review pass.
