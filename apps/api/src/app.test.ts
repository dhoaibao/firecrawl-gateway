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

  it("returns the established 404 envelope", async () => {
    const response = await request(app).get("/not-found");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: "Only /v1/*, /v2/*, /health, and /ready are handled.",
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
