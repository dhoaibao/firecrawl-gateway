import type { Request, Response } from "express";
import type { AuditStore, DeleteFilter } from "./audit-store";
import * as usersService from "./users/service";

export const validDeleteFilters = ["today", "week", "month", "all"] as const;

export function createAdminControllers(auditStore: AuditStore) {
  return {
    listLogs: async (_req: Request, res: Response): Promise<void> => {
      res.json({ data: await auditStore.readAuditEntries(500) });
    },
    deleteLog: async (req: Request, res: Response): Promise<void> => {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const deleted = await auditStore.deleteAuditEntry(id);
      if (!deleted) {
        res.status(404).json({ error: "Audit entry not found" });
        return;
      }
      res.json({ success: true });
    },
    deleteLogs: async (req: Request, res: Response): Promise<void> => {
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
      const deleted = await auditStore.deleteAuditEntries(filter as DeleteFilter);
      res.json({ success: true, deleted });
    },
    data: async (_req: Request, res: Response): Promise<void> => {
      const entries = await auditStore.readAuditEntries(500);
      const durations = entries.map((entry) => Number(entry.duration_ms)).filter((value) => Number.isFinite(value));
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
      const sanitizedUsers = users.map(({ password_hash: _passwordHash, ...rest }) => rest);
      res.json({ data: entries, totals, users: sanitizedUsers });
    },
  };
}
