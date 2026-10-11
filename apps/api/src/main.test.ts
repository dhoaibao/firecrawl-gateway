import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Capture the options the REAL createApp() passes to fastify-raw-body while
// passing through to the genuine implementation, so this test guards the
// actual registration (main.ts) instead of a hand-built Fastify instance.
const capturedRawBodyOptions: Array<Record<string, unknown> | undefined> = [];

vi.mock("fastify-raw-body", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify-raw-body")>();
  const realPlugin = actual.default as unknown as ((...pluginArgs: unknown[]) => unknown) &
    Record<PropertyKey, unknown>;
  const plugin = (...args: unknown[]) => {
    capturedRawBodyOptions.push(args[1] as Record<string, unknown> | undefined);
    return realPlugin(...args);
  };
  // fastify-plugin attaches skip-override/plugin-meta symbols to the exported
  // function; copying them keeps Fastify from creating a child encapsulation
  // context, so decorations and hooks land on the root instance as in prod.
  return { default: Object.assign(plugin, realPlugin) };
});

// Must run before "./main" is imported (static imports are hoisted), so the
// test environment is complete before the module evaluates. main.ts only
// starts listening when run directly, so importing it here does not bind a port.
const savedEnv = vi.hoisted(() => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://user:password@localhost:5432/firecrawl_gateway_test",
    // Prisma connects lazily on first query, so a non-listening URL is safe here.
    FIRECRAWL_KEYS_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    AUTH_ENABLED: "false",
    LOG_LEVEL: "silent",
    METRICS_TOKEN: "test-metrics-token-0123456789",
  });
  return saved;
});

import { createApp, drainAndClose } from "./main";
import { PrismaService } from "./prisma/prisma.service";
import { ApiKeysService } from "./api-keys/api-keys.service";

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  app = await createApp();
});

afterAll(async () => {
  await app?.close();
  process.env = savedEnv;
});

describe("raw request body handling", () => {
  it("registers fastify-raw-body via createApp with UTF-8 decoding", () => {
    expect(capturedRawBodyOptions).toEqual([
      { field: "rawBody", global: true, encoding: "utf8", runFirst: true },
    ]);
  });

  it("keeps the malformed JSON 400 through the real app pipeline", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/test",
      headers: { "content-type": "application/json" },
      payload: '{"x":',
    });

    expect(response.statusCode).toBe(400);
    // The real createApp pipeline serializes the parse failure through the
    // Nest/Fastify exception handling, which differs from a bare Fastify
    // instance: statusCode + message only, no code/error fields.
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 400,
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });
  });
});

describe("metrics endpoint", () => {
  it("rejects a scrape without the bearer token through the real pipeline", async () => {
    const response = await app.inject({ method: "GET", url: "/admin/api/metrics" });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("gateway_request_duration_seconds");
  });

  it("serves Prometheus text for the configured token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/admin/api/metrics",
      headers: { authorization: "Bearer test-metrics-token-0123456789" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^text\/plain/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("# TYPE gateway_request_duration_seconds histogram");
    expect(response.body).toContain("# TYPE gateway_rate_limited_total counter");
  });

  it("scrapes without querying Postgres even when the database is unreachable", async () => {
    // The limiter flushes to Postgres through $queryRaw; the metrics route must bypass it.
    const queryRaw = vi.spyOn(app.get(PrismaService), "$queryRaw");

    const response = await app.inject({
      method: "GET",
      url: "/admin/api/metrics",
      headers: { authorization: "Bearer test-metrics-token-0123456789" },
    });

    expect(response.statusCode).toBe(200);
    expect(queryRaw).not.toHaveBeenCalled();
    queryRaw.mockRestore();
  });
});

describe("graceful shutdown ordering", () => {
  it("persists pending per-key counts before the database disconnects", async () => {
    const closing = await createApp();
    const order: string[] = [];
    const drain = ApiKeysService.prototype.onModuleDestroy;
    const disconnect = PrismaService.prototype.onModuleDestroy;
    vi.spyOn(ApiKeysService.prototype, "onModuleDestroy").mockImplementation(async function (
      this: ApiKeysService,
    ) {
      order.push("api-keys-drain");
      await drain.call(this);
    });
    vi.spyOn(PrismaService.prototype, "onModuleDestroy").mockImplementation(async function (
      this: PrismaService,
    ) {
      order.push("prisma-disconnect");
      await disconnect.call(this);
    });

    try {
      await closing.close();
    } finally {
      vi.restoreAllMocks();
    }

    expect(order).toEqual(["api-keys-drain", "prisma-disconnect"]);
  });
});

describe("graceful shutdown", () => {
  it("drains the HTTP server before destroying modules and tolerates the second close", async () => {
    const stopping = await createApp();
    const order: string[] = [];
    const adapter = stopping.getHttpAdapter();
    const closeHttp = adapter.close.bind(adapter);
    vi.spyOn(adapter, "close").mockImplementation(async () => {
      order.push("http");
      await closeHttp();
    });
    // PrismaService is destroyed with the other modules in Nest's close().
    const destroyPrisma = PrismaService.prototype.onModuleDestroy;
    vi.spyOn(PrismaService.prototype, "onModuleDestroy").mockImplementation(async function (
      this: PrismaService,
    ) {
      order.push("modules");
      await destroyPrisma.call(this);
    });

    try {
      await expect(drainAndClose(stopping)).resolves.toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }

    expect(order.slice(0, 2)).toEqual(["http", "modules"]);
  });
});
