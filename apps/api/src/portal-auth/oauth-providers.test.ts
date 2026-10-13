import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OAuthError,
  authorizeUrl,
  completeOAuth,
  createPkce,
  enabledProviders,
} from "./oauth-providers";

const config = {
  apiOrigin: "https://api.example.com",
  googleClientId: "g-id",
  googleClientSecret: "g-secret",
  githubClientId: "",
  githubClientSecret: "",
} as never;

const githubConfig = {
  apiOrigin: "https://api.example.com",
  googleClientId: "",
  googleClientSecret: "",
  githubClientId: "h-id",
  githubClientSecret: "h-secret",
} as never;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("oauth providers", () => {
  it("enables only providers with both an id and a secret", () => {
    expect(enabledProviders(config)).toEqual(["google"]);
    expect(enabledProviders(githubConfig)).toEqual(["github"]);
  });

  it("builds an authorize URL with state and an S256 PKCE challenge", () => {
    const { verifier, challenge } = createPkce();
    expect(challenge).not.toBe(verifier);
    const url = new URL(authorizeUrl(config, "google", { state: "st", challenge }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("g-id");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/portal/api/auth/callback/google",
    );
  });

  it("exchanges the code with the verifier and returns a verified Google profile", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "tok" }))
      .mockResolvedValueOnce(
        json({
          sub: "123",
          email: " User@Example.com ",
          email_verified: true,
          name: "User",
          picture: "https://img.example.com/a.png",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const profile = await completeOAuth(config, "google", "code", "verifier");
    expect(profile).toEqual({
      provider: "google",
      providerUserId: "123",
      email: "user@example.com",
      name: "User",
      avatarUrl: "https://img.example.com/a.png",
    });
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("client_secret")).toBe("g-secret");
  });

  it("refuses an unverified Google email", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: "tok" }))
        .mockResolvedValueOnce(json({ sub: "1", email: "a@b.c", email_verified: false })),
    );
    await expect(completeOAuth(config, "google", "c", "v")).rejects.toMatchObject({
      code: "email_unverified",
    });
  });

  it("uses only GitHub's primary verified email", async () => {
    const respond = (emails: unknown[]) =>
      vi
        .fn()
        .mockResolvedValueOnce(json({ access_token: "tok" }))
        .mockResolvedValueOnce(json({ id: 7, login: "octo", avatar_url: "http://insecure/a.png" }))
        .mockResolvedValueOnce(json(emails));
    vi.stubGlobal(
      "fetch",
      respond([
        { email: "other@example.com", primary: false, verified: true },
        { email: "Main@Example.com", primary: true, verified: true },
      ]),
    );
    await expect(completeOAuth(githubConfig, "github", "c", "v")).resolves.toEqual({
      provider: "github",
      providerUserId: "7",
      email: "main@example.com",
      name: "octo",
      avatarUrl: null,
    });

    vi.stubGlobal("fetch", respond([{ email: "x@example.com", primary: true, verified: false }]));
    await expect(completeOAuth(githubConfig, "github", "c", "v")).rejects.toMatchObject({
      code: "email_unverified",
    });
  });

  it("maps provider and network failures to provider_error without leaking detail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ error: "bad_code" })));
    await expect(completeOAuth(config, "google", "c", "v")).rejects.toBeInstanceOf(OAuthError);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("socket hang up")));
    await expect(completeOAuth(config, "google", "c", "v")).rejects.toMatchObject({
      code: "provider_error",
      message: "provider_error",
    });
  });
});
