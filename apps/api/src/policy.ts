import type { NeedsCloudResult } from "./types";
import { findObjectsByKey, walk } from "./utils";

const validRouteModes = new Set(["self-hosted-first", "self-hosted-only", "cloud-first", "cloud-only"]);

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

export function getRouteMode(
  reqUrl: string,
  headers: Record<string, string | string[] | undefined>,
  defaultRouteMode: string,
): string {
  const headerMode = String(headers["x-firecrawl-route-mode"] || "").trim();
  if (validRouteModes.has(headerMode)) return headerMode;

  const parsed = new URL(reqUrl, "http://gateway.local");
  const queryMode = parsed.searchParams.get("routeMode");
  if (queryMode && validRouteModes.has(queryMode)) return queryMode;

  return validRouteModes.has(defaultRouteMode) ? defaultRouteMode : "cloud-first";
}

export function hasSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>,
  jsonBody: unknown,
): boolean {
  const normalizedKeys = new Set(
    Object.keys(headers).map((key) => key.toLowerCase()),
  );
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

export function requestNeedsCloud(
  pathname: string,
  jsonBody: unknown,
): NeedsCloudResult {
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

    if (Array.isArray((value as Record<string, unknown>).actions) && ((value as Record<string, unknown[]>).actions).length > 0) {
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
  routeMode: string,
  needsCloud: NeedsCloudResult,
): string {
  if (routeMode === "cloud-first" || routeMode === "cloud-only") return "cloud";
  if (routeMode === "self-hosted-only") return needsCloud.required ? "reject" : "self-hosted";
  return needsCloud.required ? "cloud" : "self-hosted";
}

export function isFallbackAllowed(
  routeMode: string,
  privacy: { hasSensitiveHeaders: boolean; hasPrivateTargetUrl: boolean },
): boolean {
  if (routeMode !== "self-hosted-first") return false;
  if (privacy.hasSensitiveHeaders) return false;
  if (privacy.hasPrivateTargetUrl) return false;
  return true;
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
  routeMode: string,
  needsCloud: NeedsCloudResult,
): boolean {
  if (routeMode !== "cloud-first") return false;
  return !needsCloud.required;
}

export type GatewayRequestRejection = {
  statusCode: 400 | 403 | 404 | 413;
  reason: string;
};

const MAX_ARRAY_ITEMS = 1_000;
const MAX_STRING_BYTES = 1_048_576;
const MAX_CRAWL_PAGES = 10_000;
const MAX_CRAWL_DEPTH = 10;
const MAX_BROWSER_TTL_SECONDS = 3_600;

export function isSupportedFirecrawlPath(pathname: string): boolean {
  return /^\/v[12]\/[^/]+(?:\/|$)/.test(pathname);
}

/** Token scopes are deliberately route-family based so the public endpoint ID is never a capability. */
export function tokenScopeAllowsPath(scopes: string[] | null | undefined, pathname: string): boolean {
  if (!scopes || scopes.includes("*")) return true;
  const match = pathname.match(/^\/(v[12])\/([^/?]+)/);
  if (!match) return false;
  const [, version, family] = match;
  return scopes.includes(`${version}:*`) || scopes.includes(`${version}:${family}`);
}

/**
 * Bounds the request before source selection or dispatch. URL checks are an
 * application-layer guard; deployments still need source-level network egress
 * isolation to protect against DNS rebinding and private control planes.
 */
export function validateGatewayRequest(pathname: string, body: unknown): GatewayRequestRejection | null {
  if (!isSupportedFirecrawlPath(pathname)) {
    return { statusCode: 404, reason: "Only /v1/* and /v2/* Firecrawl paths are supported" };
  }

  let rejection: GatewayRequestRejection | null = null;
  walk(body, (value) => {
    if (rejection) return;
    if (typeof value === "string") {
      if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) {
        rejection = { statusCode: 413, reason: "Request contains a string that exceeds the gateway limit" };
        return;
      }
      if (/^[a-z][a-z\d+.-]*:\/\/\S+$/i.test(value)) {
        try {
          const url = new URL(value);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            rejection = { statusCode: 400, reason: "Only HTTP(S) target URLs are allowed" };
          }
        } catch {
          rejection = { statusCode: 400, reason: "Request contains an invalid target URL" };
        }
      }
    }
    if (Array.isArray(value) && value.length > MAX_ARRAY_ITEMS) {
      rejection = { statusCode: 413, reason: "Request contains too many array items" };
    }
  });
  if (rejection) return rejection;

  if (/\/v[12]\/(crawl|batch-scrape)(?:\/|$)/.test(pathname) && body && typeof body === "object") {
    const value = body as Record<string, unknown>;
    const maxPages = value.maxPages ?? value.limit;
    if (typeof maxPages === "number" && maxPages > MAX_CRAWL_PAGES) {
      return { statusCode: 413, reason: "Requested crawl page count exceeds the gateway limit" };
    }
    if (typeof value.maxDepth === "number" && value.maxDepth > MAX_CRAWL_DEPTH) {
      return { statusCode: 413, reason: "Requested crawl depth exceeds the gateway limit" };
    }
  }
  if (/\/v[12]\/browser(?:\/|$)/.test(pathname) && body && typeof body === "object") {
    const ttl = (body as Record<string, unknown>).ttl;
    if (typeof ttl === "number" && ttl > MAX_BROWSER_TTL_SECONDS) {
      return { statusCode: 413, reason: "Requested browser TTL exceeds the gateway limit" };
    }
  }
  return null;
}
