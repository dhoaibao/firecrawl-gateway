import { beforeEach, describe, expect, it, vi } from "vitest";

const completeOAuth = vi.hoisted(() => vi.fn());
vi.mock("./oauth-providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth-providers")>()),
  completeOAuth,
}));

import {
  AccountDisabledError,
  AccountExistsError,
  IdentityInUseError,
} from "../users/users.service";
import { OAuthError } from "./oauth-providers";
import { OAUTH_STATE_COOKIE, OAuthStateCodec } from "./oauth-state";
import { PortalAuthController } from "./portal-auth.controller";
import { USER_SESSION_COOKIE } from "./user.guard";

const config = {
  apiOrigin: "https://api.example.com",
  portalOrigin: "https://app.example.com",
  sessionSecret: "session-secret",
  sessionSecure: true,
  googleClientId: "g-id",
  googleClientSecret: "g-secret",
  githubClientId: "",
  githubClientSecret: "",
} as never;

const profile = {
  provider: "google",
  providerUserId: "1",
  email: "a@b.c",
  name: "A",
  avatarUrl: null,
};
const user = { id: "u1", email: "a@b.c", name: "A", avatarUrl: null, role: "user" };

function reply() {
  const value = {
    status: 200,
    body: undefined as unknown,
    redirectTo: undefined as string | undefined,
    cookies: new Map<string, { value: string; options: Record<string, unknown> }>(),
    cleared: [] as string[],
    code(status: number) {
      value.status = status;
      return value;
    },
    send(body: unknown) {
      value.body = body;
      return value;
    },
    redirect(url: string, status?: number) {
      value.redirectTo = url;
      value.status = status ?? 302;
      return value;
    },
    setCookie(name: string, cookie: string, options: Record<string, unknown>) {
      value.cookies.set(name, { value: cookie, options });
      return value;
    },
    clearCookie(name: string) {
      value.cleared.push(name);
      return value;
    },
  };
  return value;
}

const codec = new OAuthStateCodec("session-secret");
function stateCookie(overrides: Record<string, unknown> = {}) {
  return codec.encode({
    state: "st",
    verifier: "ver",
    provider: "google",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  } as never);
}

describe("PortalAuthController", () => {
  const users = {
    resolveOAuthUser: vi.fn(),
    createSession: vi.fn(),
    revokeSession: vi.fn(),
    validateSession: vi.fn(),
    linkIdentity: vi.fn(),
  };
  let controller: PortalAuthController;

  beforeEach(() => {
    vi.clearAllMocks();
    users.resolveOAuthUser.mockResolvedValue(user);
    users.createSession.mockResolvedValue({
      token: "session-token",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    controller = new PortalAuthController(config, users as never);
  });

  it("lists only configured providers and 404s the others", async () => {
    expect(controller.providers()).toEqual({ data: { providers: ["google"] } });
    const r = reply();
    await controller.login("github", undefined, { cookies: {} } as never, r as never);
    expect(r.status).toBe(404);
    const unknown = reply();
    await controller.login("facebook", undefined, { cookies: {} } as never, unknown as never);
    expect(unknown.status).toBe(404);
  });

  it("starts sign-in with a signed state cookie and PKCE challenge", async () => {
    const r = reply();
    await controller.login("google", undefined, { cookies: {} } as never, r as never);
    expect(r.status).toBe(302);
    const target = new URL(r.redirectTo!);
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    const cookie = r.cookies.get(OAUTH_STATE_COOKIE)!;
    expect(cookie.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/portal/api/auth",
    });
    const stored = codec.decode(cookie.value)!;
    expect(stored.state).toBe(target.searchParams.get("state"));
    expect(stored.provider).toBe("google");
    expect(stored.linkUserId).toBeUndefined();
  });

  it("does not auto-link a new provider to an existing email; it points at the link flow", async () => {
    completeOAuth.mockResolvedValue(profile);
    users.resolveOAuthUser.mockRejectedValue(new AccountExistsError());
    const r = reply();
    await controller.callback(
      "google",
      { code: "c", state: "st" },
      { headers: {}, cookies: { [OAUTH_STATE_COOKIE]: stateCookie() } } as never,
      r as never,
    );
    expect(r.redirectTo).toBe("https://app.example.com/login?error=account_exists");
    expect(users.createSession).not.toHaveBeenCalled();
    expect(r.cookies.has(USER_SESSION_COOKIE)).toBe(false);
  });

  describe("linking a provider while signed in", () => {
    it("needs a signed-in session to start", async () => {
      users.validateSession.mockResolvedValue(null);
      const r = reply();
      await controller.login(
        "google",
        "1",
        { cookies: { [USER_SESSION_COOKIE]: "stale" } } as never,
        r as never,
      );
      expect(r.redirectTo).toBe("https://app.example.com/login?error=login_required");
      expect(r.cookies.has(OAUTH_STATE_COOKIE)).toBe(false);
    });

    it("binds the sign-in state to the signed-in user", async () => {
      users.validateSession.mockResolvedValue(user);
      const r = reply();
      await controller.login(
        "google",
        "1",
        { cookies: { [USER_SESSION_COOKIE]: "t" } } as never,
        r as never,
      );
      expect(codec.decode(r.cookies.get(OAUTH_STATE_COOKIE)!.value)!.linkUserId).toBe("u1");
    });

    it("attaches the provider account to that user without starting a new session", async () => {
      users.validateSession.mockResolvedValue(user);
      completeOAuth.mockResolvedValue(profile);
      const r = reply();
      await controller.callback(
        "google",
        { code: "c", state: "st" },
        {
          headers: {},
          cookies: {
            [OAUTH_STATE_COOKIE]: stateCookie({ linkUserId: "u1" }),
            [USER_SESSION_COOKIE]: "t",
          },
        } as never,
        r as never,
      );
      expect(users.linkIdentity).toHaveBeenCalledWith("u1", profile);
      expect(users.resolveOAuthUser).not.toHaveBeenCalled();
      expect(users.createSession).not.toHaveBeenCalled();
      expect(r.redirectTo).toBe("https://app.example.com/?linked=google");
    });

    it("refuses when the finishing browser is signed in as someone else or not at all", async () => {
      for (const current of [null, { ...user, id: "u2" }]) {
        users.validateSession.mockResolvedValue(current);
        const r = reply();
        await controller.callback(
          "google",
          { code: "c", state: "st" },
          {
            headers: {},
            cookies: {
              [OAUTH_STATE_COOKIE]: stateCookie({ linkUserId: "u1" }),
              [USER_SESSION_COOKIE]: "t",
            },
          } as never,
          r as never,
        );
        expect(r.redirectTo).toBe("https://app.example.com/login?error=invalid_state");
      }
      expect(completeOAuth).not.toHaveBeenCalled();
      expect(users.linkIdentity).not.toHaveBeenCalled();
    });

    it("reports a provider account that already belongs to another user", async () => {
      users.validateSession.mockResolvedValue(user);
      completeOAuth.mockResolvedValue(profile);
      users.linkIdentity.mockRejectedValue(new IdentityInUseError());
      const r = reply();
      await controller.callback(
        "google",
        { code: "c", state: "st" },
        {
          headers: {},
          cookies: {
            [OAUTH_STATE_COOKIE]: stateCookie({ linkUserId: "u1" }),
            [USER_SESSION_COOKIE]: "t",
          },
        } as never,
        r as never,
      );
      expect(r.redirectTo).toBe("https://app.example.com/login?error=identity_in_use");
    });
  });

  it("completes sign-in: sets a host-only lax session cookie and returns to the portal", async () => {
    completeOAuth.mockResolvedValue(profile);
    const r = reply();
    await controller.callback(
      "google",
      { code: "c", state: "st" },
      {
        headers: { "user-agent": "UA" },
        cookies: { [OAUTH_STATE_COOKIE]: stateCookie() },
      } as never,
      r as never,
    );
    expect(completeOAuth).toHaveBeenCalledWith(config, "google", "c", "ver");
    expect(users.createSession).toHaveBeenCalledWith("u1", "UA");
    const session = r.cookies.get(USER_SESSION_COOKIE)!;
    expect(session.value).toBe("session-token");
    expect(session.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
    });
    expect(session.options).not.toHaveProperty("domain");
    expect(r.cleared).toContain(OAUTH_STATE_COOKIE);
    expect(r.redirectTo).toBe("https://app.example.com/");
  });

  it.each([
    ["a missing state cookie", {}, { code: "c", state: "st" }],
    ["a state mismatch", { [OAUTH_STATE_COOKIE]: stateCookie() }, { code: "c", state: "other" }],
    [
      "a cookie minted for another provider",
      { [OAUTH_STATE_COOKIE]: stateCookie({ provider: "github" }) },
      { code: "c", state: "st" },
    ],
    [
      "an expired state",
      { [OAUTH_STATE_COOKIE]: stateCookie({ expiresAt: Date.now() - 1 }) },
      { code: "c", state: "st" },
    ],
    ["a missing code", { [OAUTH_STATE_COOKIE]: stateCookie() }, { state: "st" }],
  ])(
    "rejects %s without touching the provider or creating a session",
    async (_name, cookies, query) => {
      const r = reply();
      await controller.callback("google", query, { headers: {}, cookies } as never, r as never);
      expect(r.redirectTo).toBe("https://app.example.com/login?error=invalid_state");
      expect(completeOAuth).not.toHaveBeenCalled();
      expect(users.createSession).not.toHaveBeenCalled();
      expect(r.cookies.has(USER_SESSION_COOKIE)).toBe(false);
    },
  );

  it("reports a consent denial as access_denied", async () => {
    const r = reply();
    await controller.callback(
      "google",
      { error: "access_denied", state: "st" },
      { headers: {}, cookies: { [OAUTH_STATE_COOKIE]: stateCookie() } } as never,
      r as never,
    );
    expect(r.redirectTo).toBe("https://app.example.com/login?error=access_denied");
  });

  it.each([
    [new OAuthError("email_unverified"), "email_unverified"],
    [new OAuthError("provider_error"), "provider_error"],
    [new AccountDisabledError(), "account_disabled"],
    [new Error("database exploded: secret detail"), "server_error"],
  ])("maps %s to a generic login error", async (error, code) => {
    completeOAuth.mockRejectedValue(error);
    const r = reply();
    await controller.callback(
      "google",
      { code: "c", state: "st" },
      { headers: {}, cookies: { [OAUTH_STATE_COOKIE]: stateCookie() } } as never,
      r as never,
    );
    expect(r.redirectTo).toBe(`https://app.example.com/login?error=${code}`);
    expect(r.cookies.has(USER_SESSION_COOKIE)).toBe(false);
  });

  it("logs out only from the portal origin and revokes the session server-side", async () => {
    const forged = reply();
    await controller.logout(
      {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
        cookies: { [USER_SESSION_COOKIE]: "t" },
      } as never,
      forged as never,
    );
    expect(forged.status).toBe(403);
    expect(users.revokeSession).not.toHaveBeenCalled();

    const ok = reply();
    await controller.logout(
      {
        method: "POST",
        headers: { origin: "https://app.example.com" },
        cookies: { [USER_SESSION_COOKIE]: "t" },
      } as never,
      ok as never,
    );
    expect(users.revokeSession).toHaveBeenCalledWith("t");
    expect(ok.cleared).toContain(USER_SESSION_COOKIE);
  });
});
