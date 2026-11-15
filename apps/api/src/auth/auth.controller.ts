import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import { Inject } from "@nestjs/common";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import type { RequestWithContext } from "../common/types";
import { AuthGuard } from "./guards";
import { SessionService } from "./session.service";

function secureEqual(left: string, right: string): boolean {
  const leftDigest = crypto.createHash("sha256").update(left).digest();
  const rightDigest = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

@Controller("admin/api/auth")
export class AuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly sessions: SessionService,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: { email?: unknown; password?: unknown } | undefined,
    @Res() reply: FastifyReply,
  ) {
    if (!this.config.authEnabled)
      return reply
        .code(404)
        .send({ success: false, error: "Admin API is unavailable when AUTH_ENABLED=false." });
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const configuredEmail = this.config.adminEmail.trim().toLowerCase();
    if (
      !configuredEmail ||
      !this.config.adminPassword ||
      !secureEqual(email, configuredEmail) ||
      !secureEqual(password, this.config.adminPassword)
    ) {
      return reply.code(401).send({ success: false, error: "Invalid email or password" });
    }
    this.sessions.setAdmin(reply);
    return reply.send({ success: true, data: { email: configuredEmail } });
  }

  @Post("logout")
  @HttpCode(200)
  logout(@Res() reply: FastifyReply) {
    this.sessions.clearAdmin(reply);
    return reply.send({ success: true });
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@Req() request: RequestWithContext) {
    return { data: request.admin };
  }
}
