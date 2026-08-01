import { Router } from "express";
import type { User } from "../types";
import * as quotaService from "./service";
import type { QuotaRejection } from "./types";

function operatorActor(req: { user?: User }): string {
  const user = req.user as User | undefined;
  return user?.email ?? "operator";
}

function sendRejection(res: { status: (code: number) => { json: (body: unknown) => unknown } }, rejection: QuotaRejection): void {
  res.status(rejection.statusCode).json({ success: false, error: rejection.message, code: rejection.code });
}

/** Operator quota/capacity controls. Every control validates invariants server-side. */
export function createQuotaRouter() {
  const router = Router();

  router.get("/policy", async (_req, res, next) => {
    try {
      res.json({ data: await quotaService.getPolicySummary() });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/policy", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const before = await quotaService.getPolicy();
      if (!before) {
        res.status(500).json({ success: false, error: "Free tier policy is not configured" });
        return;
      }
      const result = await quotaService.updatePolicy({
        defaultGrant: body.default_grant,
        commitmentCeiling: body.commitment_ceiling,
        hardMonthlyCap: body.hard_monthly_cap,
        admissionsEnabled: body.admissions_enabled,
        includedTrafficEnabled: body.included_traffic_enabled,
        warningThresholds: body.warning_thresholds,
        actor: operatorActor(req),
        reason: typeof body.reason === "string" ? body.reason : "policy update",
      });
      res.json({ data: { before: result.before, after: result.after }, previous: before });
    } catch (error) {
      next(error);
    }
  });

  router.post("/policy/schedule-change", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      if (typeof body.period_id !== "string" || !/^\d{4}-\d{2}$/.test(body.period_id)) {
        res.status(400).json({ success: false, error: "period_id must be a YYYY-MM month" });
        return;
      }
      const policy = await quotaService.schedulePeriodChange({
        periodId: body.period_id,
        defaultGrant: body.default_grant,
        commitmentCeiling: body.commitment_ceiling,
        hardMonthlyCap: body.hard_monthly_cap,
        actor: operatorActor(req),
        reason: typeof body.reason === "string" ? body.reason : "scheduled change",
      });
      res.json({ data: policy });
    } catch (error) {
      next(error);
    }
  });

  router.post("/periods/open", async (_req, res, next) => {
    try {
      res.json({ data: await quotaService.openNextPeriod() });
    } catch (error) {
      next(error);
    }
  });

  router.get("/waitlist", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json({ data: await quotaService.listWaitlist(limit) });
    } catch (error) {
      next(error);
    }
  });

  router.post("/waitlist/admit", async (req, res, next) => {
    try {
      const accountId = String(req.body?.account_id ?? "");
      if (!accountId) {
        res.status(400).json({ success: false, error: "account_id is required" });
        return;
      }
      const outcome = await quotaService.manualAdmit(accountId, operatorActor(req), String(req.body?.reason ?? "manual admit"));
      res.json({ data: outcome });
    } catch (error) {
      if (error instanceof quotaService.QuotaRejectionError) {
        sendRejection(res, error.rejection);
        return;
      }
      next(error);
    }
  });

  router.post("/waitlist/skip", async (req, res, next) => {
    try {
      const accountId = String(req.body?.account_id ?? "");
      const reason = String(req.body?.reason ?? "skipped by operator");
      if (!accountId) {
        res.status(400).json({ success: false, error: "account_id is required" });
        return;
      }
      const enrollment = await quotaService.skipWaitlist(accountId, operatorActor(req), reason);
      if (!enrollment) {
        res.status(404).json({ success: false, error: "No waitlisted enrollment for this account" });
        return;
      }
      res.json({ data: enrollment });
    } catch (error) {
      next(error);
    }
  });

  router.post("/waitlist/process", async (_req, res, next) => {
    try {
      res.json({ data: await quotaService.processWaitlist() });
    } catch (error) {
      next(error);
    }
  });

  router.post("/accounts/:accountId/admit", async (req, res, next) => {
    try {
      const outcome = await quotaService.manualAdmit(String(req.params.accountId), operatorActor(req), String(req.body?.reason ?? "manual admit"));
      res.json({ data: outcome });
    } catch (error) {
      if (error instanceof quotaService.QuotaRejectionError) {
        sendRejection(res, error.rejection);
        return;
      }
      next(error);
    }
  });

  router.post("/accounts/:accountId/revoke", async (req, res, next) => {
    try {
      const reason = String(req.body?.reason ?? "revoked by operator");
      const enrollment = await quotaService.revokeFreeTier(String(req.params.accountId), operatorActor(req), reason);
      res.json({ data: enrollment });
    } catch (error) {
      next(error);
    }
  });

  router.post("/accounts/:accountId/adjust", async (req, res, next) => {
    try {
      const amount = Number(req.body?.amount);
      const entitlement = await quotaService.adjustAllowance(
        String(req.params.accountId),
        amount,
        operatorActor(req),
        String(req.body?.reason ?? "allowance adjustment"),
      );
      res.json({ data: entitlement });
    } catch (error) {
      if (error instanceof Error) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  });

  router.get("/entitlements", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json({ data: await quotaService.listEntitlements(limit) });
    } catch (error) {
      next(error);
    }
  });

  router.get("/events", async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json({ data: await quotaService.listQuotaEvents(limit) });
    } catch (error) {
      next(error);
    }
  });

  /** Read-only reconciliation; never repairs automatically. */
  router.get("/reconcile", async (req, res, next) => {
    try {
      const periodId = typeof req.query.period === "string" ? req.query.period : undefined;
      res.json({ data: await quotaService.reconcile(periodId) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
