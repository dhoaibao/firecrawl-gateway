import type { Request, Response, NextFunction } from "express";
import type { User } from "../types";
import { checkUserAccess } from "../users/service";

export interface AuthenticatedRequest extends Request {
  user?: User;
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const user = req.user as User | undefined;
  if (!user) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const access = checkUserAccess(user);
  if (!access.allowed) {
    res.status(403).json({ success: false, error: access.reason });
    return;
  }

  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const user = req.user as User | undefined;
  if (!user) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }

  const access = checkUserAccess(user);
  if (!access.allowed) {
    res.status(403).json({ success: false, error: access.reason });
    return;
  }

  if (user.platform_role !== "admin" && !user.is_admin) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  next();
}
