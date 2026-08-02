import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createUserPortalRouter } from "./app-api";
import type { GatewayConfig, User } from "./types";

const mocks = vi.hoisted(() => {
  const auditLog = {
    findMany: vi.fn(),
    count: vi.fn(),
  };
  const tx = {
    auditLog,
    securityEvent: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  };
  return {
    tx,
    withAccountTransaction: vi.fn(async (_accountId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
    withOperatorTransaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    getAccountByIdForTenant: vi.fn(),
    getAccountQuota: vi.fn(),
    listApiKeys: vi.fn(),
    listAccountCredentialMetadata: vi.fn(),
    sanitizeGatewayToken: vi.fn((token: unknown) => token),
    serializeUser: vi.fn((user: User) => user),
    recordSecurityEvent: vi.fn(),
    verifySensitiveAction: vi.fn(),
    queueEmail: vi.fn(),
  };
});

vi.mock("./infrastructure/database", () => ({
  withAccountTransaction: mocks.withAccountTransaction,
  withOperatorTransaction: mocks.withOperatorTransaction,
}));
vi.mock("./db/accounts", () => ({ getAccountByIdForTenant: mocks.getAccountByIdForTenant }));
vi.mock("./quota/service", () => ({ getAccountQuota: mocks.getAccountQuota }));
vi.mock("./api-keys/service", () => ({ listApiKeys: mocks.listApiKeys }));
vi.mock("./credentials/repository", () => ({ listAccountCredentialMetadata: mocks.listAccountCredentialMetadata }));
vi.mock("./api-keys/controllers", () => ({ sanitizeGatewayToken: mocks.sanitizeGatewayToken }));
vi.mock("./users/serialization", () => ({ serializeUser: mocks.serializeUser }));
vi.mock("./auth/security", () => ({
  privacyLabel: vi.fn((value: string | undefined) => value ?? null),
  recordSecurityEvent: mocks.recordSecurityEvent,
}));
vi.mock("./auth/reauth", () => ({ verifySensitiveAction: mocks.verifySensitiveAction }));
vi.mock("./auth/email", () => ({ queueEmail: mocks.queueEmail }));

const config: GatewayConfig = {
  port: 8080,
  cloudBaseUrl: "https://api.firecrawl.dev",
  defaultRouteMode: "cloud-first",
  requestTimeoutMs: 120_000,
  logFile: "",
  maxBodyBytes: 5_242_880,
  authEnabled: true,
  databaseUrl: "postgresql://localhost/test",
  operatorDatabaseUrl: "postgresql://localhost/operator-test",
  sessionSecret: "test-secret",
  authEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  adminEmail: "operator@example.com",
  adminPassword: "test-password",
  trustProxy: false,
};

const user: User = {
  id: "user-a",
  email: "user@example.com",
  normalized_email: "user@example.com",
  name: "Test User",
  password_hash: "password-hash",
  is_admin: false,
  platform_role: "user",
  email_verified_at: new Date().toISOString(),
  auth_version: 1,
  account_id: "account-a",
  status: "active",
  suspended_until: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const account = {
  id: "account-a",
  public_id: "account-public",
  display_name: "Test Account",
  status: "active",
  funding_preference: "auto" as const,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function auditRow(id = "audit-a") {
  return {
    id,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    method: "POST",
    path: "/v2/scrape",
    backendUsed: "cloud",
    fundingType: "byok",
    statusCode: 200,
    durationMs: 120,
    requestId: `request-${id}`,
  };
}

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use("/portal", createUserPortalRouter(config));
  return app;
}

describe("createUserPortalRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccountByIdForTenant.mockResolvedValue(account);
    mocks.getAccountQuota.mockResolvedValue({ period: "2026-08", reset_at: "2026-09-01T00:00:00.000Z" });
    mocks.listApiKeys.mockResolvedValue([]);
    mocks.listAccountCredentialMetadata.mockResolvedValue([]);
    mocks.tx.auditLog.findMany.mockResolvedValue([auditRow()]);
    mocks.tx.auditLog.count.mockResolvedValue(1);
    mocks.tx.securityEvent.findMany.mockResolvedValue([]);
    mocks.tx.securityEvent.create.mockResolvedValue({ id: "event-a" });
    mocks.verifySensitiveAction.mockResolvedValue({ ok: true });
  });

  it("uses the authenticated account for tenant filters and server-side pagination", async () => {
    const response = await request(buildApp())
      .get("/portal/usage?page=2&page_size=10&funding_type=byok&route_family=/v2/scrape/")
      .expect(200);

    expect(response.body.data.pagination).toEqual({ page: 2, page_size: 10, total: 1 });
    expect(mocks.getAccountByIdForTenant).toHaveBeenCalledWith("account-a");
    expect(mocks.withAccountTransaction).toHaveBeenCalledWith("account-a", expect.any(Function));
    expect(mocks.tx.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        accountId: "account-a",
        fundingType: "byok",
        OR: [
          { path: "/v2/scrape" },
          { path: { startsWith: "/v2/scrape/" } },
        ],
      }),
      skip: 10,
      take: 10,
    }));
  });

  it("requires reauthentication before exporting account data", async () => {
    mocks.verifySensitiveAction.mockResolvedValueOnce({ ok: false, error: "Current password is required" });

    await request(buildApp())
      .post("/portal/account/export")
      .send({ current_password: "wrong" })
      .expect(401);

    expect(mocks.listApiKeys).not.toHaveBeenCalled();
    expect(mocks.recordSecurityEvent).not.toHaveBeenCalled();
  });

  it("bounds large exports and marks omitted history explicitly", async () => {
    mocks.tx.auditLog.count.mockResolvedValue(10_050);
    mocks.tx.auditLog.findMany.mockImplementation(async (args: { take: number }) => Array.from({ length: args.take }, (_, index) => auditRow(`audit-${index}`)));

    const response = await request(buildApp())
      .post("/portal/account/export")
      .send({ current_password: "correct" })
      .expect(200);

    expect(response.body.data.request_history).toHaveLength(10_000);
    expect(response.body.data.request_history_truncated).toBe(true);
    expect(response.body.data.request_history_limit).toBe(10_000);
    expect(mocks.tx.auditLog.findMany.mock.calls.length).toBe(101);
    expect(mocks.recordSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "account_exported" }));
  });

  it("queues user confirmation and operator notification for deletion requests", async () => {
    const response = await request(buildApp())
      .post("/portal/account/deletion-request")
      .send({ current_password: "correct" })
      .expect(202);

    expect(response.body.data.status).toBe("queued");
    expect(response.body.data.workflow_id).toEqual(expect.any(String));
    expect(mocks.withOperatorTransaction).toHaveBeenCalled();
    expect(mocks.tx.securityEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: "account_deletion_requested" }),
    }));
    expect(mocks.queueEmail).toHaveBeenCalledTimes(2);
    expect(mocks.queueEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: "account_deletion_confirmation", recipient: user.email }));
    expect(mocks.queueEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: "account_deletion_operator_notification", recipient: config.adminEmail }));
  });
});
