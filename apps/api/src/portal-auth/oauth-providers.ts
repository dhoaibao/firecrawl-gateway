import crypto from "node:crypto";
import type { ApiConfig } from "../common/config";

export const OAUTH_PROVIDERS = ["google", "github"] as const;
export type OAuthProviderName = (typeof OAUTH_PROVIDERS)[number];

/** A provider-verified identity, normalised across providers. */
export interface OAuthProfile {
  provider: OAuthProviderName;
  providerUserId: string;
  /** Lower-cased and always verified by the provider; an unverified email never gets this far. */
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Why a sign-in failed, in terms the portal can show. Never carries provider detail. */
export type OAuthFailure = "provider_error" | "email_unverified";

export class OAuthError extends Error {
  constructor(readonly code: OAuthFailure) {
    super(code);
    this.name = "OAuthError";
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

interface ProviderDefinition {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

const DEFINITIONS: Record<OAuthProviderName, ProviderDefinition> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
  },
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
  },
};

export function isOAuthProvider(value: string): value is OAuthProviderName {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

function credentials(config: ApiConfig, provider: OAuthProviderName) {
  const id = provider === "google" ? config.googleClientId : config.githubClientId;
  const secret = provider === "google" ? config.googleClientSecret : config.githubClientSecret;
  return id && secret ? { id, secret } : null;
}

/** The providers that have both a client id and a secret configured. */
export function enabledProviders(config: ApiConfig): OAuthProviderName[] {
  return OAUTH_PROVIDERS.filter((provider) => credentials(config, provider) !== null);
}

export function callbackUrl(config: ApiConfig, provider: OAuthProviderName): string {
  return `${config.apiOrigin}/portal/api/auth/callback/${provider}`;
}

/** PKCE (RFC 7636): a random verifier and its S256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(
  config: ApiConfig,
  provider: OAuthProviderName,
  params: { state: string; challenge: string },
): string {
  const creds = credentials(config, provider);
  if (!creds) throw new OAuthError("provider_error");
  const url = new URL(DEFINITIONS[provider].authorizeUrl);
  url.searchParams.set("client_id", creds.id);
  url.searchParams.set("redirect_uri", callbackUrl(config, provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DEFINITIONS[provider].scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new OAuthError("provider_error");
  return response.json();
}

async function exchangeCode(
  config: ApiConfig,
  provider: OAuthProviderName,
  code: string,
  verifier: string,
): Promise<string> {
  const creds = credentials(config, provider);
  if (!creds) throw new OAuthError("provider_error");
  const body = new URLSearchParams({
    client_id: creds.id,
    client_secret: creds.secret,
    code,
    redirect_uri: callbackUrl(config, provider),
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const json = (await fetchJson(DEFINITIONS[provider].tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
  })) as { access_token?: unknown; error?: unknown };
  // GitHub answers 200 with an `error` field for a bad or reused code.
  if (typeof json.access_token !== "string" || !json.access_token)
    throw new OAuthError("provider_error");
  return json.access_token;
}

function cleanName(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 255) : null;
}

function cleanAvatar(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

async function googleProfile(accessToken: string): Promise<OAuthProfile> {
  const info = (await fetchJson("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  })) as Record<string, unknown>;
  if (typeof info.sub !== "string" || !info.sub || typeof info.email !== "string" || !info.email)
    throw new OAuthError("provider_error");
  if (info.email_verified !== true) throw new OAuthError("email_unverified");
  return {
    provider: "google",
    providerUserId: info.sub,
    email: info.email.trim().toLowerCase(),
    name: cleanName(info.name),
    avatarUrl: cleanAvatar(info.picture),
  };
}

async function githubProfile(accessToken: string): Promise<OAuthProfile> {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.github+json",
    "user-agent": "firecrawl-gateway",
    "x-github-api-version": "2022-11-28",
  };
  const [user, emails] = (await Promise.all([
    fetchJson("https://api.github.com/user", { headers }),
    fetchJson("https://api.github.com/user/emails", { headers }),
  ])) as [Record<string, unknown>, unknown];
  const id = typeof user.id === "number" || typeof user.id === "string" ? String(user.id) : "";
  if (!id) throw new OAuthError("provider_error");
  // Only the primary address, and only when GitHub has verified it, identifies the account.
  const primary = Array.isArray(emails)
    ? (emails as Array<Record<string, unknown>>).find(
        (entry) => entry?.primary === true && entry?.verified === true,
      )
    : undefined;
  if (!primary || typeof primary.email !== "string" || !primary.email)
    throw new OAuthError("email_unverified");
  return {
    provider: "github",
    providerUserId: id,
    email: primary.email.trim().toLowerCase(),
    name: cleanName(user.name) ?? cleanName(user.login),
    avatarUrl: cleanAvatar(user.avatar_url),
  };
}

/**
 * Completes an authorization-code + PKCE sign-in: exchanges the code and returns
 * the provider's verified identity. Throws `OAuthError` for every failure; the
 * thrown error never contains tokens, codes or provider responses.
 */
export async function completeOAuth(
  config: ApiConfig,
  provider: OAuthProviderName,
  code: string,
  verifier: string,
): Promise<OAuthProfile> {
  try {
    const accessToken = await exchangeCode(config, provider, code, verifier);
    return provider === "google"
      ? await googleProfile(accessToken)
      : await githubProfile(accessToken);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // Network failure, timeout or a malformed response.
    throw new OAuthError("provider_error");
  }
}
