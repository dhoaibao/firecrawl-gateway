import { describe, expect, it, vi } from "vitest";
import { USER_SESSION_COOKIE, UserGuard, isTrustedOrigin } from "./user.guard";

const config = { portalOrigin: "https://app.example.com" } as never;
const user = { id: "u1", email: "a@b.c", name: null, avatarUrl: null, role: "user" };

function context(request: Record<string, unknown>) {
  const reply = {
    status: 0,
    body: undefined as unknown,
    code(s: number) {
      reply.status = s;
      return reply;
    },
    send(b: unknown) {
      reply.body = b;
      return reply;
    },
  };
  return {
    reply,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
    } as never,
  };
}

describe("isTrustedOrigin", () => {
  it("lets safe methods through and pins unsafe ones to the portal origin", () => {
    const request = (method: string, origin?: string) =>
      ({ method, headers: origin ? { origin } : {} }) as never;
    expect(isTrustedOrigin(config, request("GET"))).toBe(true);
    expect(isTrustedOrigin(config, request("POST", "https://app.example.com"))).toBe(true);
    expect(isTrustedOrigin(config, request("POST"))).toBe(false);
    expect(isTrustedOrigin(config, request("POST", "https://evil.example.com"))).toBe(false);
    expect(isTrustedOrigin(config, request("DELETE", "https://sub.example.com"))).toBe(false);
    expect(isTrustedOrigin({ portalOrigin: "" } as never, request("POST", ""))).toBe(false);
  });
});

describe("UserGuard", () => {
  it("rejects a missing or invalid session and attaches the user for a valid one", async () => {
    const users = { validateSession: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(user) };
    const guard = new UserGuard(config, users as never);

    const none = context({ method: "GET", headers: {}, cookies: {} });
    expect(await guard.canActivate(none.ctx)).toBe(false);
    expect(none.reply.status).toBe(401);
    expect(users.validateSession).not.toHaveBeenCalled();

    const bad = context({ method: "GET", headers: {}, cookies: { [USER_SESSION_COOKIE]: "t" } });
    expect(await guard.canActivate(bad.ctx)).toBe(false);
    expect(bad.reply.status).toBe(401);

    const request: Record<string, unknown> = {
      method: "GET",
      headers: {},
      cookies: { [USER_SESSION_COOKIE]: "t" },
    };
    expect(await guard.canActivate(context(request).ctx)).toBe(true);
    expect(request.user).toEqual(user);
  });

  it("refuses a cross-origin write before looking at the session", async () => {
    const users = { validateSession: vi.fn() };
    const guard = new UserGuard(config, users as never);
    const { ctx, reply } = context({
      method: "POST",
      headers: { origin: "https://evil.example.com" },
      cookies: { [USER_SESSION_COOKIE]: "t" },
    });
    expect(await guard.canActivate(ctx)).toBe(false);
    expect(reply.status).toBe(403);
    expect(users.validateSession).not.toHaveBeenCalled();
  });
});
