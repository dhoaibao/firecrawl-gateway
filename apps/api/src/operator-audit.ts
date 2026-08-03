import type { NextFunction, Request, Response } from "express";
import { recordSecurityEvent } from "./auth/security";
import type { User } from "./types";

const MAX_REASON_LENGTH = 500;
const SENSITIVE_KEY = /(password|secret|token|credential|api[-_]?key|authorization|cookie|url)/i;

function boundedReason(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_REASON_LENGTH) : "";
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof item === "string") result[key] = item.slice(0, 160);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) result[key] = item;
  }
  return result;
}

export function operatorReason(req: Request): string {
  return boundedReason((req.body as Record<string, unknown> | undefined)?.reason);
}

/** Audits both reads and writes without copying request bodies or response data. */
export function operatorAuditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const user = req.user as User | undefined;
  const startedAt = Date.now();
  res.on("finish", () => {
    void recordSecurityEvent({
      userId: user?.id,
      type: "operator_api_request",
      ip: req.ip,
      userAgent: req.get("user-agent"),
      metadata: {
        actor: user?.email?.slice(0, 160) ?? "unknown",
        action: `${req.method} ${req.path}`.slice(0, 240),
        reason: operatorReason(req),
        request_id: req.requestId,
        status: res.statusCode,
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...safeMetadata((req.query ?? {}) as Record<string, unknown>),
      },
    }).catch(() => undefined);
  });
  next();
}

export function requireReason(req: Request, res: Response, next: NextFunction): void {
  const reason = operatorReason(req);
  if (!reason) {
    res.status(400).json({ success: false, error: "A reason is required for operator changes" });
    return;
  }
  next();
}
