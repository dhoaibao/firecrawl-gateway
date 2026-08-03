import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://localhost/firecrawl_test";
  process.env.OPERATOR_DATABASE_URL = "postgresql://localhost/firecrawl_operator_test";
});

import { AppModule } from "../../src/app.module";
import { configureFastifyHttp } from "../../src/common/http/fastify-http";
import { DatabaseReadinessService } from "../../src/core/database/database-readiness.service";
import { PrismaService } from "../../src/core/database/prisma.service";

const openApplications: NestFastifyApplication[] = [];

async function createApplication(databaseReady = true): Promise<{
  app: NestFastifyApplication;
  server: FastifyInstance;
}> {
  const query = databaseReady
    ? vi.fn().mockResolvedValue([{ result: 1 }])
    : vi.fn().mockRejectedValue(new Error("database unavailable"));
  const transaction = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
    $queryRaw: query,
  };
  const transactionClient = {
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction)),
  };
  const prisma = {
    runtime: transactionClient,
    operator: transactionClient,
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(DatabaseReadinessService)
    .useValue({
      assertReady: databaseReady
        ? vi.fn().mockResolvedValue(undefined)
        : vi.fn().mockRejectedValue(new Error("database unavailable")),
    })
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  configureFastifyHttp(app, []);
  await app.init();
  const server = app.getHttpAdapter().getInstance() as FastifyInstance;
  await server.ready();
  openApplications.push(app);
  return { app, server };
}

afterEach(async () => {
  await Promise.all(openApplications.splice(0).map((app) => app.close()));
});

describe("native Nest health endpoints", () => {
  it("serves health through the Fastify application", async () => {
    const { server } = await createApplication();
    const response = await server.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "health-check" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("health-check");
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("returns the readiness contract when the database is unavailable", async () => {
    const { server } = await createApplication(false);
    const response = await server.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not_ready",
      checks: { database: "error" },
    });
  });

  it("does not let API paths fall through to SPA HTML", async () => {
    const { server } = await createApplication();
    const response = await server.inject({ method: "GET", url: "/api/v1/unknown-native-route" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({ success: false });
  });

  it("enforces native auth and webhook body limits before controller execution", async () => {
    const { server } = await createApplication();
    const oversized = JSON.stringify({ value: "x".repeat(65 * 1024) });

    const authResponse = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: oversized,
    });
    const webhookResponse = await server.inject({
      method: "POST",
      url: "/api/v1/webhooks/brevo",
      headers: { "content-type": "application/json" },
      payload: oversized,
    });

    expect(authResponse.statusCode).toBe(413);
    expect(webhookResponse.statusCode).toBe(413);
  });

  it("keeps retained API route rows on the native Fastify boundary", async () => {
    const { server } = await createApplication();
    const routes = [
      ["POST", "/api/v1/auth/login"], ["POST", "/api/v1/auth/login/mfa"], ["GET", "/api/v1/auth/me"], ["POST", "/api/v1/auth/register"],
      ["POST", "/api/v1/auth/verification/request"], ["POST", "/api/v1/auth/verification/consume"], ["POST", "/api/v1/auth/password/forgot"], ["POST", "/api/v1/auth/password/reset"], ["POST", "/api/v1/auth/email"], ["POST", "/api/v1/auth/password"],
      ["GET", "/api/v1/auth/mfa"], ["POST", "/api/v1/auth/mfa/setup"], ["POST", "/api/v1/auth/mfa/enable"], ["POST", "/api/v1/auth/mfa/recovery-codes"], ["POST", "/api/v1/auth/mfa/disable"], ["GET", "/api/v1/auth/sessions"], ["DELETE", "/api/v1/auth/sessions/session-1"], ["POST", "/api/v1/auth/sessions/revoke-all"],
      ["GET", "/api/v1/app/overview"], ["GET", "/api/v1/app/dashboard"], ["GET", "/api/v1/app/account"], ["PATCH", "/api/v1/app/account"], ["POST", "/api/v1/app/account/export"], ["POST", "/api/v1/app/account/deletion-request"], ["GET", "/api/v1/app/endpoint"], ["GET", "/api/v1/app/quota"], ["GET", "/api/v1/app/usage"], ["GET", "/api/v1/app/request-history"], ["GET", "/api/v1/app/security/events"],
      ["GET", "/api/v1/app/tokens"], ["POST", "/api/v1/app/tokens"], ["DELETE", "/api/v1/app/tokens/token-1"], ["GET", "/api/v1/app/credentials"], ["POST", "/api/v1/app/credentials"], ["PUT", "/api/v1/app/credentials/credential-1"], ["POST", "/api/v1/app/credentials/credential-1/validate"], ["DELETE", "/api/v1/app/credentials/credential-1"],
      ["POST", "/api/v1/app/playground/v1/scrape"], ["POST", "/admin/api/playground/v2/scrape"],
      ["GET", "/api/v1/admin"], ["POST", "/api/v1/admin/step-up"], ["GET", "/api/v1/admin/accounts"], ["GET", "/api/v1/admin/accounts/account-1"], ["POST", "/api/v1/admin/accounts/account-1/suspend"], ["DELETE", "/api/v1/admin/accounts/account-1"], ["GET", "/api/v1/admin/usage"], ["GET", "/api/v1/admin/requests"], ["GET", "/api/v1/admin/notifications"], ["POST", "/api/v1/admin/notifications/notification-1/acknowledge"], ["GET", "/api/v1/admin/configuration"], ["PUT", "/api/v1/admin/configuration"], ["GET", "/api/v1/admin/security"], ["GET", "/api/v1/admin/capacity"],
      ["GET", "/api/v1/admin/infrastructure"], ["GET", "/api/v1/admin/infrastructure/credentials"], ["POST", "/api/v1/admin/infrastructure"], ["PATCH", "/api/v1/admin/infrastructure/source-1"], ["POST", "/api/v1/admin/infrastructure/source-1/test"], ["GET", "/api/v1/admin/settings"], ["PUT", "/api/v1/admin/settings"],
      ["GET", "/admin/api/logs"], ["DELETE", "/admin/api/logs/log-1"], ["DELETE", "/admin/api/logs"], ["GET", "/admin/api/data"], ["GET", "/admin/api/users"], ["POST", "/admin/api/users"], ["PATCH", "/admin/api/users/user-1"], ["DELETE", "/admin/api/users/user-1"], ["GET", "/admin/api/api-keys"], ["POST", "/admin/api/api-keys"], ["DELETE", "/admin/api/api-keys/key-1"], ["GET", "/admin/api/credentials"], ["GET", "/admin/api/settings"], ["GET", "/admin/api/quota/policy"], ["PATCH", "/admin/api/quota/policy"],
      ["POST", "/api/v1/webhooks/brevo"],
      ["POST", "/v1/scrape"], ["GET", "/v2/crawl/job-1"], ["GET", "/e/endpoint-1/v1/crawl/job-1"], ["POST", "/e/endpoint-1/v2/scrape"],
    ] as const;

    for (const [method, url] of routes) {
      const response = await server.inject({ method, url, payload: method === "GET" ? undefined : {}, headers: method === "GET" ? undefined : { "content-type": "application/json" } });
      expect(response.statusCode, `${method} ${url}`).not.toBe(404);
      expect(response.headers["content-type"], `${method} ${url}`).toContain("application/json");
    }
  });
});
