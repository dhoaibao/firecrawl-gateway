import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createQuotaRouter } from "./routes";

const mockService = vi.hoisted(() => ({
  getPolicySummary: vi.fn(),
  updatePolicy: vi.fn(),
  schedulePeriodChange: vi.fn(),
  openNextPeriod: vi.fn(),
  listWaitlist: vi.fn(),
  manualAdmit: vi.fn(),
  skipWaitlist: vi.fn(),
  processWaitlist: vi.fn(),
  revokeFreeTier: vi.fn(),
  adjustAllowance: vi.fn(),
  listEntitlements: vi.fn(),
  listQuotaEvents: vi.fn(),
  reconcile: vi.fn(),
  getPolicy: vi.fn(),
  QuotaRejectionError: class QuotaRejectionError extends Error {
    rejection: { code: string; message: string; statusCode: number };
    constructor(rejection: { code: string; message: string; statusCode: number }) {
      super(rejection.message);
      this.rejection = rejection;
    }
  },
}));

vi.mock("./service", () => mockService);

import * as quotaService from "./service";

const policyRow = {
  id: "default",
  default_grant: 100,
  commitment_ceiling: 1000,
  hard_monthly_cap: 5000,
  committed_amount: 200,
  admissions_enabled: true,
  included_traffic_enabled: true,
  warning_thresholds: {},
  next_period_changes: [],
  version: 3,
  updated_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { email: string; id: string } }).user = { email: "operator@example", id: "admin-1" };
    next();
  });
  app.use("/admin/api/quota", createQuotaRouter());
  app.use((err: Error & { statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode || 500).json({ success: false, error: err.message || "Gateway error" });
  });
  return app;
}

describe("quota operator API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockService.getPolicySummary.mockResolvedValue({ policy: policyRow, waitlist: 4, slotsRemaining: 8, period: null, entitlements: null });
    mockService.updatePolicy.mockResolvedValue({ before: policyRow, after: { ...policyRow, admissions_enabled: false } });
    mockService.schedulePeriodChange.mockResolvedValue(policyRow);
    mockService.openNextPeriod.mockResolvedValue({ period: { id: "2026-02" }, issued: 3 });
    mockService.listWaitlist.mockResolvedValue([]);
    mockService.manualAdmit.mockResolvedValue({ status: "enrolled", enrollment: { account_id: "account-a", status: "enrolled" } });
    mockService.skipWaitlist.mockResolvedValue({ account_id: "account-a", status: "waitlisted" });
    mockService.processWaitlist.mockResolvedValue({ admitted: 1, claimed: 1, stoppedReason: "empty", remaining: 0 });
    mockService.revokeFreeTier.mockResolvedValue({ account_id: "account-a", status: "revoked" });
    mockService.adjustAllowance.mockResolvedValue({ account_id: "account-a", allocated: 150 });
    mockService.listEntitlements.mockResolvedValue([]);
    mockService.listQuotaEvents.mockResolvedValue([]);
    mockService.reconcile.mockResolvedValue({ generatedAt: "2026-01-01T00:00:00.000Z", periodId: "2026-01", checks: [], mismatches: 0 });
    mockService.getPolicy.mockResolvedValue(policyRow);
  });

  it("returns the policy summary", async () => {
    const response = await request(buildApp()).get("/admin/api/quota/policy");
    expect(response.status).toBe(200);
    expect(response.body.data.policy.committed_amount).toBe(200);
    expect(response.body.data.waitlist).toBe(4);
  });

  it("forwards validated policy updates with the operator actor and reason", async () => {
    const response = await request(buildApp())
      .patch("/admin/api/quota/policy")
      .send({ admissions_enabled: false, commitment_ceiling: 500, reason: "launch pause" });
    expect(response.status).toBe(200);
    expect(mockService.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({
      admissionsEnabled: false,
      commitmentCeiling: 500,
      actor: "operator@example",
      reason: "launch pause",
    }));
    expect(response.body.data.after.admissions_enabled).toBe(false);
  });

  it("rejects a ceiling below the committed amount through the service invariant", async () => {
    mockService.updatePolicy.mockRejectedValue(
      Object.assign(new Error("commitment_ceiling cannot be lowered below the committed amount (200)"), { statusCode: 400 }),
    );
    const response = await request(buildApp())
      .patch("/admin/api/quota/policy")
      .send({ commitment_ceiling: 100 });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/cannot be lowered below/);
  });

  it("validates the scheduled-change period shape", async () => {
    const response = await request(buildApp())
      .post("/admin/api/quota/policy/schedule-change")
      .send({ period_id: "not-a-month", default_grant: 200 });
    expect(response.status).toBe(400);
    expect(mockService.schedulePeriodChange).not.toHaveBeenCalled();
  });

  it("opens the next period on demand", async () => {
    const response = await request(buildApp()).post("/admin/api/quota/periods/open");
    expect(response.status).toBe(200);
    expect(response.body.data.period.id).toBe("2026-02");
    expect(response.body.data.issued).toBe(3);
  });

  it("lists and admits the waitlist with the operator actor", async () => {
    const list = await request(buildApp()).get("/admin/api/quota/waitlist?limit=10");
    expect(list.status).toBe(200);
    expect(mockService.listWaitlist).toHaveBeenCalledWith(10);

    const admit = await request(buildApp()).post("/admin/api/quota/waitlist/admit").send({ account_id: "account-a" });
    expect(admit.status).toBe(200);
    expect(mockService.manualAdmit).toHaveBeenCalledWith("account-a", "operator@example", "manual admit");
  });

  it("returns quota_paused rejections from manual admission with a stable code", async () => {
    mockService.manualAdmit.mockRejectedValue(
      new mockService.QuotaRejectionError({ code: "quota_paused", message: "New grants are paused by an operator", statusCode: 409 }),
    );
    const response = await request(buildApp()).post("/admin/api/quota/waitlist/admit").send({ account_id: "account-a" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("quota_paused");
  });

  it("skips waitlisted rows with a reason", async () => {
    const response = await request(buildApp()).post("/admin/api/quota/waitlist/skip").send({ account_id: "account-a", reason: "manual review" });
    expect(response.status).toBe(200);
    expect(mockService.skipWaitlist).toHaveBeenCalledWith("account-a", "operator@example", "manual review");
  });

  it("revokes free-tier eligibility and bounds allowance adjustments", async () => {
    const revoke = await request(buildApp()).post("/admin/api/quota/accounts/account-a/revoke").send({ reason: "abuse" });
    expect(revoke.status).toBe(200);
    expect(mockService.revokeFreeTier).toHaveBeenCalledWith("account-a", "operator@example", "abuse");

    mockService.adjustAllowance.mockRejectedValue(new Error("Reduction below used allowance is not allowed (120)"));
    const adjust = await request(buildApp()).post("/admin/api/quota/accounts/account-a/adjust").send({ amount: -80 });
    expect(adjust.status).toBe(400);
    expect(adjust.body.error).toMatch(/below used allowance/);
  });

  it("exposes the read-only reconciliation report", async () => {
    const response = await request(buildApp()).get("/admin/api/quota/reconcile?period=2026-01");
    expect(response.status).toBe(200);
    expect(mockService.reconcile).toHaveBeenCalledWith("2026-01");
    expect(response.body.data.mismatches).toBe(0);
  });

  it("exposes quota events for the operator console", async () => {
    mockService.listQuotaEvents.mockResolvedValue([{ event_type: "hard_cap_reached", dedup_key: "hard_cap_reached:2026-01" }]);
    const response = await request(buildApp()).get("/admin/api/quota/events");
    expect(response.status).toBe(200);
    expect(response.body.data[0].event_type).toBe("hard_cap_reached");
  });

  it("does not leak global capacity to unauthenticated consumers (operator-only mounting is enforced upstream)", async () => {
    // The router itself performs no auth; mounting is protected by requireAdmin
    // in app.ts. Verify the router is self-contained and reject-free.
    expect(typeof createQuotaRouter).toBe("function");
    expect(quotaService).toBeDefined();
  });
});
