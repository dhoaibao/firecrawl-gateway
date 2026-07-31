import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { createProxyHandler } from "./proxy";
import { createAuditStore } from "./audit-store";
import type { GatewayConfig } from "./types";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const mockGetDefaultRouteMode = vi.hoisted(() => vi.fn());
const mockGetSetting = vi.hoisted(() => vi.fn());

vi.mock("./settings/service", () => ({
  getSetting: mockGetSetting,
  listSettings: vi.fn(),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
  getDefaultRouteMode: mockGetDefaultRouteMode,
  VALID_ROUTE_MODES: ["self-hosted-first", "self-hosted-only", "cloud-first", "cloud-only"],
}));

vi.mock("./api-keys/service", () => ({
  validateApiKey: vi.fn().mockResolvedValue(null),
  validateApiKeyWithUser: vi.fn().mockResolvedValue(null),
  touchApiKey: vi.fn(),
}));

vi.mock("./users/service", () => ({
  getUserById: vi.fn(),
  checkUserAccess: vi.fn().mockReturnValue({ allowed: true }),
}));

const baseConfig: GatewayConfig = {
  port: 8080,
  cloudBaseUrl: "https://api.firecrawl.dev",
  defaultRouteMode: "self-hosted-first",
  requestTimeoutMs: 120_000,
  logFile: "",
  maxBodyBytes: 5_242_880,
  authEnabled: false,
  databaseUrl: "postgresql://localhost/test",
  sessionSecret: "secret",
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  adminEmail: "",
  adminPassword: "",
  trustProxy: false,
};

async function buildApp({
  logFile,
  routeMode,
  fetchMock,
  requestId,
}: {
  logFile: string;
  routeMode: string;
  fetchMock: typeof fetch;
  requestId: string;
}) {
  vi.stubGlobal("fetch", fetchMock);
  const auditStore = createAuditStore(logFile);
  const handler = createProxyHandler({
    config: { ...baseConfig, logFile, defaultRouteMode: routeMode as GatewayConfig["defaultRouteMode"] },
    auditStore,
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { requestId: string }).requestId = requestId;
    next();
  });
  app.use(express.raw({ type: "*/*", limit: "5mb" }));
  app.use("/v1", async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  });

  return { app, auditStore };
}

describe("proxy audit logging", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-audit-"));
    logFile = path.join(tmpDir, "audit.jsonl");
    vi.clearAllMocks();
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-first");
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["fc_test_key"]', updated_at: new Date().toISOString() };
      }
      return null;
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("writes an audit entry before finishing a self-hosted-first response", async () => {
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-first");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });

    const { app, auditStore } = await buildApp({
      logFile,
      routeMode: "self-hosted-first",
      fetchMock,
      requestId: "req-self-hosted",
    });

    await request(app)
      .post("/v1/scrape")
      .set("content-type", "application/json")
      .send(JSON.stringify({ url: "https://example.com" }))
      .expect(200);

    const entries = await auditStore.readAuditEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.route_mode).toBe("self-hosted-first");
    expect(entries[0]?.backend_used).toBe("self-hosted");
  });

  it("writes an audit entry before finishing a cloud-first response", async () => {
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });

    const { app, auditStore } = await buildApp({
      logFile,
      routeMode: "cloud-first",
      fetchMock,
      requestId: "req-cloud",
    });

    await request(app)
      .post("/v1/scrape")
      .set("content-type", "application/json")
      .send(JSON.stringify({ url: "https://example.com" }))
      .expect(200);

    const entries = await auditStore.readAuditEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.route_mode).toBe("cloud-first");
    expect(entries[0]?.backend_used).toBe("cloud");
  });
});
