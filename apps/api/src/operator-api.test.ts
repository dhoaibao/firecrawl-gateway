import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("./auth/middleware", () => ({
  requireOperatorMfa: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./operator-audit", () => ({
  operatorAuditMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  operatorReason: () => "test reason",
  requireReason: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createOperatorRouter } from "./operator-api";

const config = {
  authEnabled: true,
  authEncryptionKey: "a".repeat(64),
  firecrawlKeysEncryptionKey: "b".repeat(64),
  providerCredentialsEncryptionKey: "c".repeat(64),
  adminEmail: "operator@example.com",
  cloudBaseUrl: "https://cloud.example.com",
} as never;

function appFor(role: "admin" | "user", checkDatabase?: () => Promise<boolean>) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: "operator-1",
      email: "operator@example.com",
      name: "Operator",
      password_hash: "hash",
      is_admin: role === "admin",
      platform_role: role,
      status: "active",
      suspended_until: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    next();
  });
  app.use("/api/v1/admin", createOperatorRouter(config, checkDatabase));
  return app;
}

describe("operator API boundary", () => {
  it("rejects an ordinary user before exposing operator data", async () => {
    const response = await request(appFor("user")).get("/api/v1/admin/");
    expect(response.status).toBe(403);
    expect(response.body.error).toContain("operator role");
  });

  it("allows an active platform operator to reach the console boundary", async () => {
    const response = await request(appFor("admin")).get("/api/v1/admin/");
    expect(response.status).toBe(200);
    expect(response.body.data.service).toBe("operator-console");
  });

  it("blocks every operator route when database prerequisites are degraded", async () => {
    const response = await request(appFor("admin", async () => false)).post("/api/v1/admin/accounts/user-1/suspend").send({ reason: "maintenance" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("operator_read_only");
    expect(response.body.data.read_only).toBe(true);
  });
});
