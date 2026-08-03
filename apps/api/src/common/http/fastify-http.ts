import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { rootLogger } from "../../logger";
import type { RequestWithId } from "../interceptors/request-id.interceptor";

const AUTH_BODY_LIMIT_BYTES = 32 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function contentSecurityPolicy(corsOrigins: readonly string[]): string {
  const connectSources = ["'self'", ...corsOrigins].join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src ${connectSources}`,
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
  ].join("; ");
}

export function configureFastifyHttp(
  app: NestFastifyApplication,
  corsOrigins: readonly string[],
): void {
  app.enableCors({
    origin: corsOrigins.length > 0 ? [...corsOrigins] : false,
    credentials: corsOrigins.length > 0,
  });

  const server = app.getHttpAdapter().getInstance() as FastifyInstance;
  const startedAt = new WeakMap<FastifyRequest, number>();
  server.addHook("onRoute", (route) => {
    if (route.url.startsWith("/api/v1/auth") || route.url.startsWith("/admin/api/auth")) {
      route.bodyLimit = AUTH_BODY_LIMIT_BYTES;
    }
  });
  server.addHook("onRequest", async (request, reply) => {
    startedAt.set(request, Date.now());
    const requestedId = request.headers["x-request-id"];
    const requestId = typeof requestedId === "string" && REQUEST_ID_PATTERN.test(requestedId)
      ? requestedId
      : request.id || randomUUID();
    (request as RequestWithId).requestId = requestId;
    void reply.header("x-request-id", requestId);
  });
  server.addHook("onResponse", async (request, reply) => {
    const status = reply.statusCode;
    const meta = {
      request_id: (request as RequestWithId).requestId,
      method: request.method,
      path: request.url.split("?", 1)[0],
      status,
      duration_ms: Date.now() - (startedAt.get(request) ?? Date.now()),
    };
    if (status >= 500) rootLogger.error(meta, "request error");
    else if (status >= 400) rootLogger.warn(meta, "request warning");
    else rootLogger.info(meta, "request completed");
  });
  server.addHook("onSend", async (_request, reply, payload) => {
    void reply.headers({
      "content-security-policy": contentSecurityPolicy(corsOrigins),
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "origin-agent-cluster": "?1",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-dns-prefetch-control": "off",
      "x-download-options": "noopen",
      "x-frame-options": "SAMEORIGIN",
      "x-permitted-cross-domain-policies": "none",
      "x-xss-protection": "0",
    });
    return payload;
  });
}
