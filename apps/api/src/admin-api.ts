import { json, Router } from "express";
import type { AuditStore } from "./audit-store";
import * as usersService from "./users/service";
import { requireAdmin, requireOperatorMfa } from "./auth/middleware";

const validDeleteFilters = ["today", "week", "month", "all"] as const;

export function createAdminRouter(auditStore: AuditStore) {
  const router = Router();

  router.get("/logs", requireAdmin, requireOperatorMfa, async (_req, res) => {
    const entries = await auditStore.readAuditEntries(500);
    res.json({ data: entries });
  });

  router.delete("/logs/:id", requireAdmin, requireOperatorMfa, async (req, res) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deleted = await auditStore.deleteAuditEntry(id);
    if (!deleted) {
      res.status(404).json({ error: "Audit entry not found" });
      return;
    }
    res.json({ success: true });
  });

  router.delete("/logs", json(), requireAdmin, requireOperatorMfa, async (req, res) => {
    if (req.body?.ids !== undefined) {
      if (!Array.isArray(req.body.ids)) {
        res.status(400).json({ error: "ids must be an array" });
        return;
      }
      const rawIds = req.body.ids as unknown[];
      if (rawIds.some((id) => typeof id !== "string" || id.trim().length === 0)) {
        res.status(400).json({ error: "ids must contain only non-empty strings" });
        return;
      }
      const ids = [...new Set((rawIds as string[]).map((id) => id.trim()))];
      if (ids.length === 0) {
        res.status(400).json({ error: "At least one log id is required" });
        return;
      }
      const deleted = await auditStore.deleteAuditEntriesByIds(ids);
      res.json({ success: true, deleted });
      return;
    }

    const filter = req.query.filter as string;
    if (!validDeleteFilters.includes(filter as typeof validDeleteFilters[number])) {
      res.status(400).json({ error: "Invalid filter. Use: today, week, month, or all" });
      return;
    }
    const deleted = await auditStore.deleteAuditEntries(filter as typeof validDeleteFilters[number]);
    res.json({ success: true, deleted });
  });

  router.get("/data", requireAdmin, requireOperatorMfa, async (_req, res) => {
    const entries = await auditStore.readAuditEntries(500);
    const durations = entries
      .map((entry) => Number(entry.duration_ms))
      .filter((value) => Number.isFinite(value));
    const avgDuration = durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0;

    const totals = {
      total: entries.length,
      self_hosted: entries.filter((entry) => entry.backend_used === "self-hosted").length,
      cloud: entries.filter((entry) => entry.backend_used === "cloud").length,
      fallbacks: entries.filter((entry) => entry.fallback_used).length,
      avgDuration,
    };

    const users = await usersService.listUsers();
    const sanitizedUsers = users.map((user) => {
      const { password_hash, ...rest } = user;
      return rest;
    });

    res.json({ data: entries, totals, users: sanitizedUsers });
  });

  return router;
}
