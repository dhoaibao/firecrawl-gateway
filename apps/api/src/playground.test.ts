import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { createProxyHandler } from "./proxy";
import { createAuditStore } from "./audit-store";
import type { GatewayConfig, User } from "./types";
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
  authEnabled: true,
  databaseUrl: "postgresql://localhost/test",
  operatorDatabaseUrl: "postgresql://localhost/operator-test",
  sessionSecret: "secret",
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  adminEmail: "",
  adminPassword: "",
  trustProxy: false,
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "User",
    password_hash: "hash",
    is_admin: false,
    status: "active",
    suspended_until: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function buildApp({
  logFile,
  fetchMock,
}: {
  logFile: string;
  fetchMock: typeof fetch;
}) {
  vi.stubGlobal("fetch", fetchMock);
  const auditStore = createAuditStore(logFile);
  const handler = createProxyHandler({
    config: baseConfig,
    auditStore,
    getTrustedUserId: (req) => (req.user as User | undefined)?.id,
  });

  const app = express();
  app.use((req, _res, next) => {
    req.user = makeUser();
    next();
  });
  app.use("/admin/api/playground", async (req, res, next) => {
    if (!/^\/v[12]\//.test(req.url)) {
      res.status(404).json({ success: false, error: "Only /v1/* and /v2/* are supported" });
      return;
    }
    req.originalUrl = req.originalUrl.replace(/^\/admin\/api\/playground/, "") || "/";
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  });

  return { app, auditStore };
}

describe("/admin/api/playground", () => {
  let tmpDir: string;
  let logFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-playground-"));
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

  it("rewrites the path and proxies to the Firecrawl endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });

    const { app, auditStore } = await buildApp({ logFile, fetchMock });

    await request(app)
      .post("/admin/api/playground/v2/scrape")
      .set("content-type", "application/json")
      .send(JSON.stringify({ url: "https://example.com" }))
      .expect(200);

    const calls = fetchMock.mock.calls.filter(([url]) => !String(url).includes("/v2/team/credit-usage"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain("/v2/scrape");
    expect(calls[0]?.[0]).not.toContain("/admin/api/playground");

    const entries = await auditStore.readAuditEntries(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("/v2/scrape");
    expect(entries[0]?.user_id).toBe("user-1");
  });

  it("preserves query string parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });

    const { app } = await buildApp({ logFile, fetchMock });

    await request(app)
      .post("/admin/api/playground/v2/scrape?timeout=30000")
      .set("content-type", "application/json")
      .send(JSON.stringify({ url: "https://example.com" }))
      .expect(200);

    const callUrl = fetchMock.mock.calls.find(([url]) => !String(url).includes("/v2/team/credit-usage"))?.[0] as string;
    expect(callUrl).toContain("/v2/scrape");
    expect(callUrl).toContain("timeout=30000");
  });

  it("rejects non-Firecrawl paths", async () => {
    const fetchMock = vi.fn();
    const { app } = await buildApp({ logFile, fetchMock });

    const res = await request(app)
      .get("/admin/api/playground/admin/api/settings")
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
