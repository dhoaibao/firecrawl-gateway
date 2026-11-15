import { describe, expect, it, vi } from "vitest";
import { AuthGuard } from "./guards";

function makeContext() {
  const request: Record<string, unknown> = {};
  const reply = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  };
  return { context: context as never, request, reply };
}

describe("AuthGuard", () => {
  it("answers 404 and denies when authentication is disabled", async () => {
    const sessions = { getAdmin: vi.fn() };
    const guard = new AuthGuard({ authEnabled: false } as never, sessions as never);
    const { context, reply } = makeContext();

    await expect(guard.canActivate(context)).resolves.toBe(false);

    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      success: false,
      error: "Admin API is unavailable when AUTH_ENABLED=false.",
    });
    expect(sessions.getAdmin).not.toHaveBeenCalled();
  });

  it("answers 401 and denies when there is no valid admin session", async () => {
    const sessions = { getAdmin: vi.fn().mockReturnValue(null) };
    const guard = new AuthGuard({ authEnabled: true } as never, sessions as never);
    const { context, request, reply } = makeContext();

    await expect(guard.canActivate(context)).resolves.toBe(false);

    expect(sessions.getAdmin).toHaveBeenCalledWith(request);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ success: false, error: "Unauthorized" });
    expect(request).not.toHaveProperty("admin");
  });

  it("allows a valid session and exposes the admin on the request", async () => {
    const admin = { email: "admin@example.com" };
    const sessions = { getAdmin: vi.fn().mockReturnValue(admin) };
    const guard = new AuthGuard({ authEnabled: true } as never, sessions as never);
    const { context, request, reply } = makeContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(request.admin).toBe(admin);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });
});
