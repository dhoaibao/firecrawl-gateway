import { All, Controller, Req, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { GatewayController } from "./gateway.controller";

@Controller()
@UseGuards(AuthGuard)
export class PlaygroundController {
  constructor(private readonly gateway: GatewayController) {}

  @All(["api/v1/app/playground/v1/*", "api/v1/app/playground/v2/*", "admin/api/playground/v1/*", "admin/api/playground/v2/*"])
  async proxy(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const originalUrl = request.raw.url ?? request.url;
    const prefix = originalUrl.startsWith("/admin/api/playground") ? "/admin/api/playground" : "/api/v1/app/playground";
    const rewritten = originalUrl.replace(prefix, "") || "/";
    const originalRequestUrl = request.url;
    const originalRawUrl = request.raw.url;
    (request as FastifyRequest & { url: string }).url = rewritten;
    request.raw.url = rewritten;
    try {
      await this.gateway.proxy(request, reply);
    } finally {
      (request as FastifyRequest & { url: string }).url = originalRequestUrl;
      request.raw.url = originalRawUrl;
    }
  }
}
