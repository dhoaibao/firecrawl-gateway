import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuditStore } from "./audit-store";

vi.mock("./auth/middleware", () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireOperatorMfa: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("./auth/security", () => ({
  recordSecurityEvent: vi.fn().mockResolvedValue(undefined),
}));

import { createAdminRouter } from "./admin-api";

function createTestApp(auditStore: AuditStore) {
  const app = express();
  app.use(createAdminRouter(auditStore));
  return app;
}

function createAuditStoreMock(): AuditStore {
  return {
    appendAudit: vi.fn().mockResolvedValue(undefined),
    readAuditEntries: vi.fn().mockResolvedValue([]),
    deleteAuditEntry: vi.fn().mockResolvedValue(false),
    deleteAuditEntriesByIds: vi.fn().mockResolvedValue(0),
    deleteAuditEntries: vi.fn().mockResolvedValue(0),
  };
}

describe("createAdminRouter", () => {
  it("deletes selected logs from a JSON request body", async () => {
    const auditStore = createAuditStoreMock();
    vi.mocked(auditStore.deleteAuditEntriesByIds).mockResolvedValue(2);

    const response = await request(createTestApp(auditStore))
      .delete("/logs")
      .send({ ids: ["audit-one", "audit-two", "audit-one"], exception: "account-deletion", reason: "Customer account deletion request" })
      .expect(200);

    expect(response.body).toEqual({ success: true, deleted: 2 });
    expect(auditStore.deleteAuditEntriesByIds).toHaveBeenCalledWith(["audit-one", "audit-two"], "account-deletion");
  });

  it("rejects an empty selected-log list", async () => {
    const auditStore = createAuditStoreMock();

    await request(createTestApp(auditStore))
      .delete("/logs")
      .send({ ids: [] })
      .expect(400);

    expect(auditStore.deleteAuditEntriesByIds).not.toHaveBeenCalled();
  });

  it("rejects mixed or blank selected-log ids", async () => {
    const auditStore = createAuditStoreMock();

    await request(createTestApp(auditStore))
      .delete("/logs")
      .send({ ids: ["audit-one", 42] })
      .expect(400);
    await request(createTestApp(auditStore))
      .delete("/logs")
      .send({ ids: ["audit-one", "   "] })
      .expect(400);

    expect(auditStore.deleteAuditEntriesByIds).not.toHaveBeenCalled();
  });
});
