import type { ExecutionContext } from "@nestjs/common";
import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { RateLimitService } from "./rate-limit.service";
import { RateLimitGuard } from "./rate-limit.guard";

function contextFor(request: Partial<FastifyRequest>) {
  const reply = { header: vi.fn() } as unknown as FastifyReply;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
  return { context, reply };
}

describe("RateLimitGuard", () => {
  it("uses bounded caller and operation keys without storing bearer credentials", async () => {
    const resetAt = new Date(Date.now() + 60_000);
    const rateLimits = {
      consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 299, resetAt }),
    } as unknown as RateLimitService;
    const guard = new RateLimitGuard(rateLimits);
    const { context, reply } = contextFor({
      method: "POST",
      url: "/api/v1/auth/login?token=secret",
      ip: "192.0.2.1",
      headers: { authorization: "Bearer raw-secret" },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    const keys = vi.mocked(rateLimits.consume).mock.calls[0][0];
    expect(keys).toContain("auth:ip:192.0.2.1");
    expect(keys).toContain("auth:operation:POST:/api/v1/auth/login:ip:192.0.2.1");
    expect(keys.join(" ")).not.toContain("raw-secret");
    expect(keys.join(" ")).not.toContain("token=secret");
    expect(reply.header).toHaveBeenCalledWith("x-ratelimit-remaining", "299");
  });

  it("returns 429 with Retry-After when the shared limit is exhausted", async () => {
    const rateLimits = {
      consume: vi.fn().mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) }),
    } as unknown as RateLimitService;
    const guard = new RateLimitGuard(rateLimits);
    const { context, reply } = contextFor({ method: "GET", url: "/api/v1/app/settings", ip: "192.0.2.2", headers: {} });

    await expect(guard.canActivate(context)).rejects.toSatisfy(
      (error: unknown) => error instanceof HttpException && error.getStatus() === 429,
    );
    expect(reply.header).toHaveBeenCalledWith("retry-after", expect.any(String));
  });

  it("fails closed when the PostgreSQL limiter is unavailable", async () => {
    const rateLimits = {
      consume: vi.fn().mockRejectedValue(new Error("database unavailable")),
    } as unknown as RateLimitService;
    const guard = new RateLimitGuard(rateLimits);
    const { context } = contextFor({ method: "POST", url: "/api/v1/auth/login", ip: "192.0.2.3", headers: {} });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
