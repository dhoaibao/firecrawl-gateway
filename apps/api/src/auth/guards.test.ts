import { describe, expect, it } from "vitest";
import { AuthGuard } from "./guards";

const config = {
  authEnabled: true,
  adminOrigin: "https://admin.example.com",
  apiOrigin: "https://api.example.com",
};

function run(
  method: string,
  origin: string | undefined,
  overrides: Record<string, unknown> = {},
  admin: unknown = { email: "admin@example.com" },
) {
  const reply = {
    status: 0,
    code(status: number) {
      reply.status = status;
      return reply;
    },
    send() {
      return reply;
    },
  };
  const request: Record<string, unknown> = { method, headers: origin ? { origin } : {} };
  const guard = new AuthGuard(
    { ...config, ...overrides } as never,
    {
      getAdmin: () => admin,
    } as never,
  );
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as never;
  return guard.canActivate(ctx).then((allowed) => ({ allowed, status: reply.status }));
}

describe("AuthGuard origin check", () => {
  it("refuses a state-changing admin request from another site, even with a valid session", async () => {
    expect(await run("POST", "https://app.example.com")).toEqual({ allowed: false, status: 403 });
    expect(await run("DELETE", "https://evil.example.com")).toEqual({
      allowed: false,
      status: 403,
    });
  });

  it("accepts the admin's own origins, non-browser callers, and safe methods", async () => {
    expect((await run("POST", "https://admin.example.com")).allowed).toBe(true);
    expect((await run("POST", "https://api.example.com")).allowed).toBe(true);
    expect((await run("POST", undefined)).allowed).toBe(true);
    expect((await run("GET", "https://app.example.com")).allowed).toBe(true);
  });

  it("does not enforce an origin when none is configured", async () => {
    const result = await run("POST", "http://localhost:5173", { adminOrigin: "", apiOrigin: "" });
    expect(result.allowed).toBe(true);
  });

  it("still requires a session", async () => {
    expect(await run("GET", undefined, {}, null)).toEqual({ allowed: false, status: 401 });
  });
});
