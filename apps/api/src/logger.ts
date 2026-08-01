import pino from "pino";
import type { Request } from "express";

export const rootLogger = pino({
  level: process.env.LOG_LEVEL || "info",
});

export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return rootLogger.child(bindings);
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      /** Server-generated per-HTTP-request id used for quota idempotency. */
      quotaRequestId: string;
    }
  }
}

export function getRequestLogger(req: Request): pino.Logger {
  return rootLogger.child({ request_id: req.requestId });
}
