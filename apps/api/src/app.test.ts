import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import session from "express-session";
import { createApp } from "./app";
import type { AuditStore } from "./audit-store";
import type { GatewayConfig } from "./types";

const config: GatewayConfig = {
  port: 8080,
  cloudBaseUrl: "https://api.firecrawl.dev",
  defaultRouteMode: "cloud-first",
  requestTimeoutMs: 120_000,
  logFile: "/tmp/gateway-test.jsonl",
  maxBodyBytes: 5_242_880,
  authEnabled: false,
  databaseUrl: "postgresql://localhost/test",
  operatorDatabaseUrl: "postgresql://localhost/operator-test",
  sessionSecret: "test-secret",
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  adminEmail: "",
  adminPassword: "",
  trustProxy: false,
};

const auditStore: AuditStore = {
  appendAudit: vi.fn(),
  readAuditEntries: vi.fn().mockResolvedValue([]),
  deleteAuditEntry: vi.fn(),
  deleteAuditEntriesByIds: vi.fn(),
  deleteAuditEntries: vi.fn(),
};

describe("createApp", () => {
  const app = createApp({
    config,
    auditStore,
    checkDatabase: vi.fn().mockResolvedValue(true),
    handleProxy: async (_req, res) => {
      res.status(200).json({ success: true, data: "proxied" });
    },
  });

  it("sets hardened headers and emits a bounded request id", async () => {
    const response = await request(app)
      .get("/not-found?token=must-not-be-logged")
      .set("X-Request-ID", "client-id_123");

    expect(response.headers["x-request-id"]).toBe("client-id_123");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("replaces oversized or malformed request ids", async () => {
    const response = await request(app)
      .get("/not-found")
      .set("X-Request-ID", "x".repeat(129));

    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps health and readiness outside request logging and rate limiting", async () => {
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });

    const ready = await request(app).get("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready", checks: { database: "ok" } });
    expect(ready.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  it("keeps the no-auth admin boundary and proxy routes stable", async () => {
    const admin = await request(app).get("/admin");
    expect(admin.status).toBe(404);
    expect(admin.body.error).toContain("AUTH_ENABLED=false");

    const proxied = await request(app).get("/v1/scrape");
    expect(proxied.status).toBe(200);
    expect(proxied.body).toEqual({ success: true, data: "proxied" });
  });

  it("mounts tenant routes with only the Firecrawl suffix exposed to the proxy", async () => {
    const handleTenantProxy = vi.fn(async (req: import("express").Request, res: import("express").Response) => {
      res.json({ url: req.url, endpointId: (req as import("express").Request & { tenantEndpointId?: string }).tenantEndpointId });
    });
    const tenantApp = createApp({
      config,
      auditStore,
      checkDatabase: vi.fn().mockResolvedValue(true),
      handleProxy: handleTenantProxy,
    });

    const response = await request(tenantApp).get("/e/public-endpoint/v2/scrape?formats=markdown");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: "/v2/scrape?formats=markdown", endpointId: "public-endpoint" });
  });

  it("returns the established 404 envelope", async () => {
    const response = await request(app).get("/not-found");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: "Only /e/:endpointId/v1/*, /e/:endpointId/v2/*, /v1/*, /v2/*, /health, and /ready are handled.",
    });
  });

  it("composes the auth-enabled app with an injected session middleware", async () => {
    const authApp = createApp({
      config: { ...config, authEnabled: true },
      auditStore,
      sessionMiddleware: session({
        secret: "test-secret",
        resave: false,
        saveUninitialized: false,
      }),
      checkDatabase: vi.fn().mockResolvedValue(true),
      handleProxy: async (_req, res) => {
        res.status(200).json({ success: true, data: "proxied" });
      },
    });

    const response = await request(authApp).get("/admin/api/auth/me");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ success: false, error: "Unauthorized" });
  });
});
