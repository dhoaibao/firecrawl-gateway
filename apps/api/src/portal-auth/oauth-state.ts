import crypto from "node:crypto";
import type { OAuthProviderName } from "./oauth-providers";

export const OAUTH_STATE_COOKIE = "fg.oauth";
/** How long the browser may take to complete the provider's consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface OAuthState {
  state: string;
  verifier: string;
  provider: OAuthProviderName;
  expiresAt: number;
  /** Set when a signed-in user is linking another provider rather than signing in. */
  linkUserId?: string;
}

/**
 * The in-flight sign-in (CSRF `state` and PKCE verifier) lives in a short-lived,
 * signed, HTTP-only cookie, so no server-side storage is needed and a callback
 * that does not carry the browser's own cookie is rejected. The signing key is
 * derived from the session secret and is not used for anything else.
 */
export class OAuthStateCodec {
  private readonly key: Buffer;

  constructor(sessionSecret: string) {
    this.key = crypto.createHash("sha256").update(`portal-oauth-state\n${sessionSecret}`).digest();
  }

  encode(value: OAuthState): string {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** Returns the state, or null when the cookie is missing, forged, or expired. */
  decode(cookie: string | undefined, now = Date.now()): OAuthState | null {
    if (!cookie) return null;
    const separator = cookie.lastIndexOf(".");
    if (separator < 1) return null;
    const payload = cookie.slice(0, separator);
    const signature = cookie.slice(separator + 1);
    const expected = this.sign(payload);
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
      if (
        typeof value.state !== "string" ||
        typeof value.verifier !== "string" ||
        (value.provider !== "google" && value.provider !== "github") ||
        typeof value.expiresAt !== "number" ||
        value.expiresAt <= now ||
        (value.linkUserId !== undefined && typeof value.linkUserId !== "string")
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }

  /** Constant-time comparison of the `state` returned by the provider with the stored one. */
  static stateMatches(expected: string, received: string): boolean {
    const a = crypto.createHash("sha256").update(expected).digest();
    const b = crypto.createHash("sha256").update(received).digest();
    return crypto.timingSafeEqual(a, b);
  }

  private sign(payload: string): string {
    return crypto.createHmac("sha256", this.key).update(payload).digest("base64url");
  }
}
