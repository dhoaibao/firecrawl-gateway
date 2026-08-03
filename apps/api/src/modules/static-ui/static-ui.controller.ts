import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Controller, Get, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppConfigService } from "../../core/config/config.service";

const NOT_FOUND = {
  success: false,
  error: "Only /e/:endpointId/v1/*, /e/:endpointId/v2/*, /v1/*, /v2/*, /health, and /ready are handled.",
};
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

@Controller()
export class StaticUiController {
  private readonly webRoot = [path.resolve(process.cwd(), "apps/web/dist"), path.resolve(process.cwd(), "../web/dist"), path.resolve(__dirname, "../../../../web/dist")].find((candidate) => existsSync(candidate)) ?? path.resolve(process.cwd(), "apps/web/dist");

  constructor(private readonly config: AppConfigService) {}

  @Get("*")
  async serve(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const pathname = new URL(request.raw.url ?? request.url, "http://gateway.local").pathname;
    if (this.isApiOrSystemPath(pathname)) {
      reply.code(404).send(NOT_FOUND);
      return;
    }
    if (!this.config.authEnabled) {
      if (pathname === "/admin" || pathname.startsWith("/admin/")) {
        reply.code(404).send({ success: false, error: "Admin UI is unavailable when AUTH_ENABLED=false." });
      } else {
        reply.code(404).send(NOT_FOUND);
      }
      return;
    }

    const filePath = this.safeFilePath(pathname);
    if (filePath) {
      try {
        const file = await fs.readFile(filePath);
        reply.type(contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream").send(file);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (this.isSpaPath(pathname)) {
      try {
        reply.type("text/html; charset=utf-8").send(await fs.readFile(path.join(this.webRoot, "index.html")));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    reply.code(404).send(NOT_FOUND);
  }

  private safeFilePath(pathname: string): string | undefined {
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); } catch { return undefined; }
    const candidate = path.resolve(this.webRoot, `.${decoded}`);
    const relative = path.relative(this.webRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return candidate;
  }

  private isSpaPath(pathname: string): boolean {
    return pathname === "/" || pathname === "/login" || pathname === "/register" || pathname === "/verify-email" || pathname === "/forgot-password" || pathname === "/reset-password" || pathname === "/app" || pathname.startsWith("/app/") || pathname === "/admin" || pathname.startsWith("/admin/");
  }

  private isApiOrSystemPath(pathname: string): boolean {
    return pathname === "/health" || pathname === "/ready" || pathname === "/api" || pathname.startsWith("/api/") || pathname === "/admin/api" || pathname.startsWith("/admin/api/") || pathname === "/v1" || pathname.startsWith("/v1/") || pathname === "/v2" || pathname.startsWith("/v2/") || pathname.startsWith("/e/");
  }
}
