import type { ErrorRequestHandler, RequestHandler } from "express";
import { rootLogger } from "../../logger";
import type { GatewayConfig } from "../../types";

export function notFoundHandler(config: GatewayConfig): RequestHandler {
  return (_req, res) => {
    const handledPaths = config.authEnabled
      ? "/e/:endpointId/v1/*, /e/:endpointId/v2/*, /v1/*, /v2/*, /health, /ready, and /admin"
      : "/e/:endpointId/v1/*, /e/:endpointId/v2/*, /v1/*, /v2/*, /health, and /ready";
    res.status(404).json({ success: false, error: `Only ${handledPaths} are handled.` });
  };
}

export const errorHandler: ErrorRequestHandler = (err: Error, req, res, _next) => {
  rootLogger.error({ err, requestId: req.requestId }, "Gateway error");
  if (res.headersSent) return;
  const isDev = process.env.NODE_ENV !== "production";
  const statusCode = (err as Error & { statusCode?: number }).statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: err.message || "Gateway error",
    ...(isDev ? { stack: err.stack } : {}),
  });
};
