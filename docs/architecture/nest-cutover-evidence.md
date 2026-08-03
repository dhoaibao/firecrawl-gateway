# Native Nest/Fastify cutover evidence

This document records repository-local evidence for the native runtime boundary. It does not replace live PostgreSQL/security validation or the final deletion approval.

## Entrypoints

- API: `apps/api/src/main.ts` builds `AppModule` with `FastifyAdapter` and `@fastify/session`.
- Worker: `apps/api/src/worker-main.ts` builds `WorkerAppModule` as a Nest application context.
- Database: `PrismaService` uses separate `DATABASE_URL` and `OPERATOR_DATABASE_URL` clients; transaction contexts explicitly assume the runtime or operator role.
- Deployment: `deploy/docker-entrypoint.sh` starts `apps/api/dist/main.js` or `apps/api/dist/worker-main.js`.
- Native entrypoints do not import `app.ts`, `server.ts`, `proxy.ts`, Passport, or the legacy background-job entrypoint.

## Native boundary coverage

- Health/readiness: `apps/api/test/e2e/health.e2e.test.ts`; disposable PostgreSQL smoke evidence confirms `/health` 200 and `/ready` 200 after migrations/security installation.
- API negative-space and parser limits: `apps/api/test/e2e/health.e2e.test.ts` and `apps/api/src/modules/static-ui/static-ui.controller.spec.ts`.
- Webhook authorization, event identifiers, duplicate handling, and response shape: `apps/api/src/modules/webhooks/` tests.
- Gateway source leases and BYOK last-use touch: `apps/api/src/modules/gateway/presentation/gateway.controller.spec.ts`.
- Gateway transport streaming, bounded buffering, upstream failure, request abort, real loopback streaming, and real timeout behavior: `apps/api/src/modules/gateway/application/gateway-transport.service.spec.ts`.
- Operator platform-admin, MFA/step-up/reason boundary: `apps/api/src/modules/operator/presentation/operator.guards.spec.ts`.
- Native email and audit worker ownership: `apps/api/src/modules/email/` and `apps/api/src/modules/audit/`.

## Static repository checks

Run from the repository root:

```bash
rg -n 'startBackgroundJobs|createBrevoWebhookRouter' apps/api/src/main.ts apps/api/src/worker-main.ts apps/api/src/worker-app.module.ts apps/api/src/modules
rg -n 'dist/(server|main|worker-main)\\.js|src/(server|main|worker-main)\\.ts' apps deploy docker-compose*.yaml .github docs README.md SELF_HOST.md
rtk git diff --check
```

The first check must return no legacy worker/webhook imports from native entrypoints. The second check should show only native deployment references and documented legacy source inventory until the final deletion gate is approved.

## Remaining gated evidence

- Disposable live PostgreSQL role/grant/RLS/session/quota/security verification.
- Real external-upstream fallback smoke testing; loopback streaming, abort, and timeout evidence is covered by the gateway transport test.
- Complete success-path contract evidence for every route-matrix row.
