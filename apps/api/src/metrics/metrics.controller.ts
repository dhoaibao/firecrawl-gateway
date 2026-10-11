import { Controller, Get, Headers, Inject, Res } from "@nestjs/common";
import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { MetricsService } from "./metrics.service";

function matchesBearer(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  if (!match) return false;
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(digest(match[1]), digest(token));
}

/**
 * Prometheus scrape target, served under `/admin/api` because the bundled nginx
 * only forwards that prefix. It is authenticated with `METRICS_TOKEN` (not the
 * admin session) and does not exist (404) until the token is configured.
 */
@Controller("admin/api/metrics")
export class MetricsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  async scrape(
    @Headers("authorization") authorization: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const token = this.config.metricsToken;
    if (!token) return reply.code(404).send({ success: false, error: "Not found" });
    if (!matchesBearer(authorization, token))
      return reply
        .code(401)
        .header("www-authenticate", "Bearer")
        .send({ success: false, error: "Unauthorized" });
    const { contentType, body } = await this.metrics.render();
    return reply.header("content-type", contentType).header("cache-control", "no-store").send(body);
  }
}
