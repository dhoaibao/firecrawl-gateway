import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { User } from "../types";
import { checkUserAccess } from "../users/service";
import { validateAndTouchSession, getMfaState, sessionHasMfaVerification } from "./security";

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
  if (req.sessionID && user.auth_version !== undefined) {
    void validateAndTouchSession(req.sessionID, user.id, user.auth_version).then((valid) => {
      if (!valid) res.status(401).json({ success: false, error: "Unauthorized" });
      else next();
    }).catch(next);
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

/** Additional gate for operator routes; password-only sessions are insufficient. */
export function requireOperatorMfa(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const user = req.user as User | undefined;
  if (!user || (user.platform_role !== "admin" && !user.is_admin)) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  if (!req.sessionID || user.auth_version === undefined) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return;
  }
  void Promise.all([
    getMfaState(user.id),
    sessionHasMfaVerification(req.sessionID, user.id, user.auth_version),
  ]).then(([state, sessionMfaVerified]) => {
    if (!state.enabled || !state.verified || !sessionMfaVerified) {
      res.status(403).json({ success: false, error: "Operator MFA is required" });
      return;
    }
    next();
  }).catch(next);
}

export function csrfMiddleware(corsOrigin?: string) {
  const allowedOrigins = new Set((corsOrigin || "").split(",").map((origin) => origin.trim()).filter(Boolean));
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !req.isAuthenticated?.()) {
      next();
      return;
    }
    const origin = req.get("origin");
    const sameOrigin = `${req.protocol}://${req.get("host") || ""}`;
    // A session-authenticated browser mutation must carry an explicit origin.
    // Rejecting a missing origin prevents token-only cross-site requests from
    // bypassing the browser-origin boundary.
    if (!origin || (origin !== sameOrigin && !allowedOrigins.has(origin))) {
      res.status(403).json({ success: false, error: "CSRF validation failed" });
      return;
    }
    const supplied = req.get("x-csrf-token");
    const session = req.session as typeof req.session & { csrfToken?: string };
    if (!session.csrfToken || !supplied || !safeEqual(session.csrfToken, supplied)) {
      res.status(403).json({ success: false, error: "CSRF validation failed" });
      return;
    }
    next();
  };
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
