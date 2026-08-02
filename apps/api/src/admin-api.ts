import { json, Router } from "express";
import type { AuditStore } from "./audit-store";
import { requireAdmin, requireOperatorMfa } from "./auth/middleware";
import { asyncHandler } from "./infrastructure/http/async-handler";
import { createAdminControllers } from "./admin-api.controllers";

export function createAdminRouter(auditStore: AuditStore) {
  const router = Router();
  const controllers = createAdminControllers(auditStore);

  router.get("/logs", requireAdmin, requireOperatorMfa, asyncHandler(controllers.listLogs));
  router.delete("/logs/:id", requireAdmin, requireOperatorMfa, asyncHandler(controllers.deleteLog));
  router.delete("/logs", json(), requireAdmin, requireOperatorMfa, asyncHandler(controllers.deleteLogs));
  router.get("/data", requireAdmin, requireOperatorMfa, asyncHandler(controllers.data));

  return router;
}
