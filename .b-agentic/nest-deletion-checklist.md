# NestJS cutover deletion evidence

The Express compatibility stack has been removed from the working tree after native entrypoint, route, worker, and dependency checks.

## Removed

- Express composition and runtime: `app.ts`, `server.ts`, legacy middleware, async/error handlers, and the Express session store.
- Legacy route composition: portal/admin/operator/auth/token/credential/quota/settings/user routers and controllers.
- Legacy gateway and worker composition: `proxy.ts`, `worker.ts`, legacy jobs, and characterization tests.
- Passport/session/email adapters and obsolete compatibility tests.
- Express-only dependencies and types, including Express, Passport, compression, CORS, Helmet, and Supertest packages.
- One-time legacy source conversion/validation scripts and their obsolete top-level persistence adapters.

## Retained native dependencies

- Shared PostgreSQL/Prisma helpers still used by native quota, audit, rate-limit, and authentication services.
- Native Nest/Fastify modules under `apps/api/src/modules/` and native entrypoints under `apps/api/src/main.ts` and `apps/api/src/worker-main.ts`.

## Remaining evidence

- Complete success-path native route contract evidence for every route-matrix row.
- Disposable live PostgreSQL role, grant, forced-RLS, session, quota, job, audit, and readiness verification.
- Real upstream HTTP streaming, abort, timeout, fallback, and BYOK smoke tests.
- Changed-code review before commit or deployment.
