import type { Backend, CloudKeyEntry, NeedsCloudResult } from "../common/types";
import { findObjectsByKey, walk } from "../common/utils";

export const VALID_ROUTE_MODES = [
  "self-hosted-first",
  "self-hosted-only",
  "cloud-first",
  "cloud-only",
  "hybrid",
] as const;
export type RouteMode = (typeof VALID_ROUTE_MODES)[number];
/** Used until the admin saves a `default_route_mode` setting. */
export const DEFAULT_ROUTE_MODE: RouteMode = "cloud-first";

export type InitialBackend = Backend | "reject";

/** Facts about a request that restrict falling back to Cloud. */
export interface PrivacyFlags {
  hasSensitiveHeaders: boolean;
  hasPrivateTargetUrl: boolean;
}

const cloudOnlyPathPatterns = [
  /^\/v\d+\/agent(?:\/|$)/,
  /^\/v\d+\/browser(?:\/|$)/,
  /^\/v\d+\/monitor(?:\/|$)/,
  /^\/v\d+\/search\/research(?:\/|$)/,
  /^\/v\d+\/research(?:\/|$)/,
  /^\/v\d+\/support(?:\/|$)/,
  /^\/v\d+\/team(?:\/|$)/,
  /^\/v\d+\/feedback(?:\/|$)/,
  /^\/v\d+\/scrape\/[^/]+\/interact(?:\/|$)/,
  /^\/v\d+\/search\/[^/]+\/feedback(?:\/|$)/,
];

export function hasSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
  jsonBody: unknown,
): boolean {
  const normalizedKeys = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
  if (normalizedKeys.has("authorization") || normalizedKeys.has("cookie")) return true;

  const bodyHeaders = findObjectsByKey(jsonBody, "headers");
  for (const item of bodyHeaders) {
    if (!item || typeof item !== "object") continue;
    for (const key of Object.keys(item as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (
        lower === "authorization" ||
        lower === "cookie" ||
        lower === "x-api-key" ||
        lower.includes("token") ||
        lower.includes("secret")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function requestNeedsCloud(pathname: string, jsonBody: unknown): NeedsCloudResult {
  for (const pattern of cloudOnlyPathPatterns) {
    if (pattern.test(pathname)) {
      return {
        required: true,
        reason: "path requires a Firecrawl Cloud managed feature",
      };
    }
  }

  let reason: string | null = null;
  walk(jsonBody, (value: unknown) => {
    if (reason || !value || typeof value !== "object") return;

    if (
      Array.isArray((value as Record<string, unknown>).actions) &&
      (value as Record<string, unknown[]>).actions.length > 0
    ) {
      reason = "actions require Fire-engine-backed Cloud behavior";
      return;
    }

    if ((value as Record<string, unknown>).agent) {
      reason = "agent extraction is Cloud-managed";
      return;
    }

    const enterprise = (value as Record<string, unknown>).enterprise;
    if (Array.isArray(enterprise) && enterprise.length > 0) {
      reason = "enterprise search options require Firecrawl Cloud";
      return;
    }

    const proxy = (value as Record<string, unknown>).proxy;
    if (proxy === "stealth" || proxy === "enhanced") {
      reason = "stealth/enhanced proxy requires Cloud-managed behavior";
    }
  });

  return { required: Boolean(reason), reason: reason || "" };
}

export function chooseInitialBackend(
  routeMode: RouteMode,
  needsCloud: NeedsCloudResult,
): InitialBackend {
  if (routeMode === "cloud-first" || routeMode === "cloud-only" || routeMode === "hybrid")
    return "cloud";
  if (routeMode === "self-hosted-only") return needsCloud.required ? "reject" : "self-hosted";
  return needsCloud.required ? "cloud" : "self-hosted";
}

/**
 * Splits the configured keys into the pool Cloud is tried with first and the
 * reserve held back for later. Only `hybrid` honours key roles: its `cloud`
 * keys come first and its `fallback` keys back up self-hosted. Without a
 * `cloud` key hybrid starts on self-hosted, or on the reserve when the request
 * requires Cloud. Every other mode uses all keys as one pool.
 */
export function selectKeyPools(
  routeMode: RouteMode,
  initialBackend: InitialBackend,
  needsCloud: NeedsCloudResult,
  entries: CloudKeyEntry[],
): { initialBackend: InitialBackend; cloudApiKeys: string[]; fallbackApiKeys: string[] } {
  if (routeMode !== "hybrid")
    return {
      initialBackend,
      cloudApiKeys: entries.map((entry) => entry.key),
      fallbackApiKeys: [],
    };
  const keysWithRole = (role: CloudKeyEntry["role"]) =>
    entries.filter((entry) => entry.role === role).map((entry) => entry.key);
  const cloudApiKeys = keysWithRole("cloud");
  const fallbackApiKeys = keysWithRole("fallback");
  if (cloudApiKeys.length) return { initialBackend, cloudApiKeys, fallbackApiKeys };
  return {
    initialBackend: needsCloud.required ? "cloud" : "self-hosted",
    cloudApiKeys: fallbackApiKeys,
    fallbackApiKeys: [],
  };
}

export function isFallbackAllowed(routeMode: RouteMode, privacy: PrivacyFlags): boolean {
  if (routeMode !== "self-hosted-first" && routeMode !== "hybrid") return false;
  if (privacy.hasSensitiveHeaders) return false;
  if (privacy.hasPrivateTargetUrl) return false;
  return true;
}

/** Whether the request may use a Cloud key, directly or as a self-hosted fallback. */
export function mayUseCloudKeys(
  initialBackend: InitialBackend,
  routeMode: RouteMode,
  privacy: PrivacyFlags,
): boolean {
  return (
    initialBackend === "cloud" ||
    (initialBackend === "self-hosted" && isFallbackAllowed(routeMode, privacy))
  );
}

export function isFallbackEligible(result: {
  kind: string;
  response?: Response;
  body?: Buffer;
}): boolean {
  if (result.kind === "network-error") return true;
  if (!result.response) return false;
  if (result.response.status >= 500) return true;

  const text = result.body?.toString("utf8").toLowerCase() || "";
  return (
    result.response.status >= 400 &&
    (text.includes("fire-engine") ||
      text.includes("not configured") ||
      text.includes("not supported") ||
      text.includes("unsupported") ||
      /\bcannot\s+(?:get|post|put|patch|delete|head|options)\b/.test(text) ||
      text.includes("actions") ||
      text.includes("screenshot") ||
      text.includes("branding"))
  );
}

export function isCloudQuotaFallbackAllowed(
  routeMode: RouteMode,
  needsCloud: NeedsCloudResult,
): boolean {
  if (routeMode !== "cloud-first" && routeMode !== "hybrid") return false;
  return !needsCloud.required;
}
