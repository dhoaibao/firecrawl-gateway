import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://localhost/firecrawl_test";
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
  const prisma = {
    $transaction: vi.fn(async (operation: (client: typeof transaction) => Promise<unknown>) => operation(transaction)),
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
});
