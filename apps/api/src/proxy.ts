import type { Request, Response } from "express";
import { Readable } from "node:stream";
import type { AuditStore } from "./audit-store";
import type { GatewayConfig, ProxyResult, AuditEntry } from "./types";
import {
  chooseInitialBackend,
  getRouteMode,
  hasSensitiveHeaders,
  isFallbackAllowed,
  isFallbackEligible,
  isCloudQuotaFallbackAllowed,
  requestNeedsCloud,
} from "./policy";
import {
  collectTargetUrls,
  cryptoRandomId,
  hasPrivateTargetUrl,
  inspectBody,
  nowIso,
  shuffleArray,
} from "./utils";
import * as apiKeyService from "./api-keys/service";
import * as userService from "./users/service";
import * as settingsService from "./settings/service";
import { getRequestLogger } from "./logger";
import { decryptSettingValue, encryptSettingValue } from "./settings/crypto";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

async function getCloudApiKeys(config: GatewayConfig): Promise<string[]> {
  try {
    const record = await settingsService.getSetting("firecrawl_api_keys");
    if (record?.value) {
      const decrypted = decryptSettingValue(record.value, config.firecrawlKeysEncryptionKey);
      if (!decrypted.encrypted) {
        await settingsService.setSetting(
          "firecrawl_api_keys",
          encryptSettingValue(record.value, config.firecrawlKeysEncryptionKey),
        );
      }
      const parsed = JSON.parse(decrypted.value) as unknown;
      const keys = Array.isArray(parsed)
        ? parsed.filter((k): k is string => typeof k === "string" && k.length > 0)
        : [];
      return prioritizeCloudApiKeys(config, keys);
    }
  } catch {
    // ignore parse errors and decryption errors
  }
  return [];
}

const CREDIT_USAGE_CACHE_TTL_MS = 30_000;
const creditUsageCache = new Map<string, { remainingCredits: number; expiresAt: number }>();
const creditUsageInFlight = new Map<string, Promise<number | null>>();

async function getRemainingCredits(config: GatewayConfig, apiKey: string): Promise<number | null> {
  const cached = creditUsageCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) return cached.remainingCredits;
  if (cached) creditUsageCache.delete(apiKey);

  const existing = creditUsageInFlight.get(apiKey);
  if (existing) return existing;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${config.cloudBaseUrl}/v2/team/credit-usage`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const json = (await response.json()) as { data?: { remainingCredits?: number } };
      const remainingCredits = json.data?.remainingCredits;
      if (typeof remainingCredits !== "number") return null;
      creditUsageCache.set(apiKey, { remainingCredits, expiresAt: Date.now() + CREDIT_USAGE_CACHE_TTL_MS });
      return remainingCredits;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })();

  creditUsageInFlight.set(apiKey, request);
  try {
    return await request;
  } finally {
    if (creditUsageInFlight.get(apiKey) === request) {
      creditUsageInFlight.delete(apiKey);
    }
  }
}

async function prioritizeCloudApiKeys(config: GatewayConfig, keys: string[]): Promise<string[]> {
  const credits = await Promise.all(keys.map(async (key) => ({
    key,
    remainingCredits: await getRemainingCredits(config, key),
  })));

  // Shuffle first so keys with the same balance (including unavailable balances)
  // are randomized, then sort known balances from highest to lowest.
  return shuffleArray(credits)
    .sort((a, b) => (b.remainingCredits ?? Number.NEGATIVE_INFINITY) - (a.remainingCredits ?? Number.NEGATIVE_INFINITY))
    .map(({ key }) => key);
}

function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>,
  backend: string,
  apiKey?: string,
  authEnabled?: boolean,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (hopByHopHeaders.has(lower)) continue;
    if (lower === "x-firecrawl-route-mode") continue;
    // Strip the virtual API key before forwarding; only send auth to cloud.
    // In auth-disabled mode the Authorization header belongs to the client and
    // must be preserved for the self-hosted backend (transparent proxy behavior).
    if (lower === "authorization" && backend !== "cloud" && authEnabled) continue;
    if (value === undefined) continue;
    next[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  if (backend === "cloud" && apiKey) {
    next.authorization = `Bearer ${apiKey}`;
  }

  return next;
}

export function headersForPrivacyCheck(
  headers: Record<string, string | string[] | undefined>,
  authEnabled: boolean,
): Record<string, string | string[] | undefined> {
  if (!authEnabled) return headers;

  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === "authorization") {
      delete next[key];
    }
  }
  return next;
}

async function readRequestBody(req: Request, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBodyBytes) {
      const error = new Error("Request body is too large for gateway inspection");
      (error as Error & { statusCode: number }).statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxyToBackend({
  backend,
  req,
  bodyBuffer,
  targetUrl,
  config,
  apiKey,
}: {
  backend: string;
  req: Request;
  bodyBuffer: Buffer;
  targetUrl: string;
  config: GatewayConfig;
  apiKey?: string;
}): Promise<ProxyResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const started = Date.now();
  let streamingResponse = false;

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: sanitizeHeaders(req.headers, backend, apiKey, config.authEnabled),
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuffer,
      redirect: "manual",
      signal: controller.signal,
    });

    // Successful responses are streamed directly to the client. Error responses
    // remain buffered because routing fallback decisions inspect their payload.
    if ((response.ok || response.status < 400) && response.body) {
      streamingResponse = true;
      return {
        kind: "response",
        backend,
        response,
        stream: response.body,
        cleanup: () => clearTimeout(timeout),
        durationMs: Date.now() - started,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    return {
      kind: "response",
      backend,
      response,
      body: Buffer.from(arrayBuffer),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      kind: "network-error",
      backend,
      error: error as Error,
      body: Buffer.from(
        JSON.stringify({
          success: false,
          error:
            (error as Error).name === "AbortError"
              ? "Gateway upstream timeout"
              : (error as Error).message,
        }),
      ),
      durationMs: Date.now() - started,
    };
  } finally {
    // Streamed responses keep the timeout alive until their body completes.
    if (!streamingResponse) clearTimeout(timeout);
  }
}

function backendUrl(
  backend: string,
  originalUrl: string,
  config: GatewayConfig,
  selfHostedBaseUrl: string,
): string {
  const base = backend === "cloud" ? config.cloudBaseUrl : selfHostedBaseUrl;
  return `${base}${originalUrl}`;
}

async function sendProxyResponse(
  res: Response,
  result: ProxyResult,
  meta: { fallbackUsed: boolean; fallbackReason: string },
): Promise<void> {
  if (result.kind === "network-error") {
    res.status(502).set({
      "content-type": "application/json; charset=utf-8",
      "x-hybrid-firecrawl-backend": result.backend,
      "x-hybrid-firecrawl-fallback": String(meta.fallbackUsed),
      "x-hybrid-firecrawl-fallback-reason": meta.fallbackReason || "",
    });
    res.end(result.body);
    return;
  }

  const headers: Record<string, string> = {};
  if (result.response) {
    result.response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (hopByHopHeaders.has(lower)) return;
      if (!result.stream && lower === "content-encoding") return;
      headers[key] = value;
    });
  }
  headers["x-hybrid-firecrawl-backend"] = result.backend;
  headers["x-hybrid-firecrawl-fallback"] = String(meta.fallbackUsed);
  if (meta.fallbackReason) {
    headers["x-hybrid-firecrawl-fallback-reason"] = meta.fallbackReason;
  }
  if (!result.stream && result.body) {
    headers["content-length"] = String(result.body.length);
  }

  res.status(result.response?.status || 502).set(headers);
  if (result.stream) {
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(result.stream as ReadableStream<Uint8Array>)
        .once("error", reject)
        .once("end", resolve)
        .pipe(res)
        .once("close", resolve)
        .once("error", reject);
    }).finally(() => {
      result.cleanup?.();
    });
  } else {
    res.end(result.body);
  }
}

/** Status codes that suggest trying another cloud API key */
const RETRYABLE_CLOUD_STATUS = new Set([401, 403, 429]);

export function createProxyHandler({
  config,
  auditStore,
  getTrustedUserId,
  getTrustedAccountId,
}: {
  config: GatewayConfig;
  auditStore: AuditStore;
  getTrustedUserId?: (req: Request) => string | undefined;
  getTrustedAccountId?: (req: Request) => string | undefined;
}) {
  return async function handleProxy(
    req: Request,
    res: Response,
  ): Promise<void> {
    const trustedUserId = getTrustedUserId?.(req);
    const trustedAccountId = getTrustedAccountId?.(req);
    const log = getRequestLogger(req);
    const started = Date.now();
    const requestUrl = req.originalUrl || req.url;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(requestUrl, "http://gateway.local");
    } catch {
      res.status(400).json({ success: false, error: "Invalid request URL" });
      return;
    }
    let userId: string | undefined;
    let accountId: string | undefined = trustedAccountId;
    let primaryTargetUrl = "";
    let routeMode: string = config.defaultRouteMode;
    const appendAuditEntry = async ({
      backendUsed,
      statusCode,
      fallbackUsed = false,
      fallbackReason = "",
    }: {
      backendUsed: string;
      statusCode: number;
      fallbackUsed?: boolean;
      fallbackReason?: string;
    }): Promise<void> => {
      const auditEntry: AuditEntry = {
        id: cryptoRandomId(),
        created_at: nowIso(),
        method: req.method,
        path: parsedUrl.pathname,
        route_mode: routeMode,
        backend_used: backendUsed,
        fallback_used: fallbackUsed,
        fallback_reason: fallbackReason,
        status_code: statusCode,
        duration_ms: Date.now() - started,
        target_url: primaryTargetUrl,
        user_id: userId,
        account_id: accountId,
        request_id: req.requestId,
      };
      try {
        await auditStore.appendAudit(auditEntry);
      } catch (auditErr) {
        log.warn({ err: auditErr }, "Failed to write audit entry; continuing request");
      }
    };

    const defaultRouteMode = await settingsService.getDefaultRouteMode(config.defaultRouteMode);
    const selfHostedBaseUrl = (await settingsService.getSetting("self_hosted_firecrawl_url"))?.value
      ?.replace(/\/+$/, "") || "";
    routeMode = getRouteMode(
      requestUrl,
      req.headers,
      defaultRouteMode,
    );

    // Validate virtual API key when auth is enabled and request is not from a trusted session caller
    if (config.authEnabled && !trustedUserId) {
      const authHeader = String(req.headers.authorization || "");
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (!match) {
        await appendAuditEntry({
          backendUsed: "none",
          statusCode: 401,
          fallbackReason: "Missing or invalid API key",
        });
        res.status(401).json({ success: false, error: "Missing or invalid API key" });
        return;
      }
      const apiKey = match[1];
      const authenticatedKey = await apiKeyService.validateApiKeyWithUser(apiKey);
      if (!authenticatedKey) {
        await appendAuditEntry({
          backendUsed: "none",
          statusCode: 401,
          fallbackReason: "Invalid or revoked API key",
        });
        res.status(401).json({ success: false, error: "Invalid or revoked API key" });
        return;
      }

      const { key: validKey, user: keyOwner } = authenticatedKey;
      const access = userService.checkUserAccess(keyOwner);
      if (!access.allowed) {
        await appendAuditEntry({
          backendUsed: "none",
          statusCode: 403,
          fallbackReason: access.reason,
        });
        res.status(403).json({ success: false, error: access.reason });
        return;
      }

      userId = validKey.user_id;
      accountId = validKey.account_id ?? keyOwner.account_id;
      apiKeyService.touchApiKey(validKey.id).catch((err) => {
        log.warn({ err }, "Failed to update API key last used timestamp");
      });
    } else if (trustedUserId) {
      userId = trustedUserId;
    }

    let bodyBuffer: Buffer;
    try {
      bodyBuffer = await readRequestBody(req, config.maxBodyBytes);
    } catch (error) {
      await appendAuditEntry({
        backendUsed: "none",
        statusCode: (error as Error & { statusCode?: number }).statusCode || 500,
        fallbackReason: (error as Error).message || "Gateway error",
      });
      throw error;
    }
    const { json, parseError } = inspectBody(bodyBuffer, req.headers);
    if (parseError) {
      await appendAuditEntry({
        backendUsed: "none",
        statusCode: 400,
        fallbackReason: parseError,
      });
      res.status(400).json({ success: false, error: "Invalid JSON body", details: parseError });
      return;
    }
    const targetUrls = collectTargetUrls(json);
    primaryTargetUrl = targetUrls[0] || "";
    const privacyHeaders = headersForPrivacyCheck(req.headers, config.authEnabled);
    const privacy = {
      hasSensitiveHeaders: hasSensitiveHeaders(privacyHeaders, json),
      hasPrivateTargetUrl: hasPrivateTargetUrl(targetUrls),
    };
    const needsCloud = requestNeedsCloud(parsedUrl.pathname, json);
    const initialBackend = chooseInitialBackend(routeMode, needsCloud);
    let cloudApiKeys: string[] = [];
    if (
      initialBackend === "cloud" ||
      (initialBackend === "self-hosted" && routeMode !== "self-hosted-only" && isFallbackAllowed(routeMode, privacy))
    ) {
      cloudApiKeys = await getCloudApiKeys(config);
    }
    const primaryCloudApiKey = cloudApiKeys[0];

    if (initialBackend === "cloud" && !primaryCloudApiKey) {
      const statusCode = 502;
      log.warn(
        { reason: needsCloud.reason },
        "request requires Firecrawl Cloud but no primary API key configured",
      );
      await appendAuditEntry({
        backendUsed: "none",
        statusCode,
        fallbackReason: "No Firecrawl Cloud API key configured",
      });
      res.status(statusCode).json({
        success: false,
        error: "No Firecrawl Cloud API key configured. Add one in Settings.",
      });
      return;
    }

    log.info(
      {
        route_mode: routeMode,
        initial_backend: initialBackend,
        needs_cloud: needsCloud.required,
        needs_cloud_reason: needsCloud.reason || undefined,
      },
      "routing decision",
    );

    if (initialBackend === "reject") {
      const statusCode = 409;
      log.warn(
        { reason: needsCloud.reason },
        "request rejected: requires cloud in self-hosted-only mode",
      );
      await appendAuditEntry({
        backendUsed: "none",
        statusCode,
        fallbackReason: needsCloud.reason,
      });
      res.status(statusCode).json({
        success: false,
        error:
          "This request requires Firecrawl Cloud, but route mode is self-hosted-only.",
        reason: needsCloud.reason,
      });
      return;
    }

    let result = await proxyToBackend({
      backend: initialBackend,
      req,
      bodyBuffer,
      targetUrl: backendUrl(initialBackend, requestUrl, config, selfHostedBaseUrl),
      config,
      apiKey: initialBackend === "cloud" ? primaryCloudApiKey : undefined,
    });
    let fallbackUsed = false;
    let fallbackReason = "";

    if (
      initialBackend === "self-hosted" &&
      Boolean(primaryCloudApiKey) &&
      isFallbackEligible(result) &&
      isFallbackAllowed(routeMode, privacy)
    ) {
      fallbackUsed = true;
      fallbackReason =
        result.kind === "network-error"
          ? result.error?.message || "self-hosted network error"
          : `self-hosted returned ${result.response?.status}`;
      log.warn(
        { fallback_reason: fallbackReason },
        "falling back from self-hosted to cloud",
      );
      result = await proxyToBackend({
        backend: "cloud",
        req,
        bodyBuffer,
        targetUrl: backendUrl("cloud", requestUrl, config, selfHostedBaseUrl),
        config,
        apiKey: primaryCloudApiKey,
      });
    }

    // Try next cloud API keys on auth/rate-limit errors
    let allCloudKeysQuotaLimited = false;
    if (
      result.backend === "cloud" &&
      result.kind === "response" &&
      result.response &&
      RETRYABLE_CLOUD_STATUS.has(result.response.status)
    ) {
      const remainingKeys = cloudApiKeys.slice(1);
      let quotaLimitedAttempts = result.response.status === 429 ? 1 : 0;
      let totalAttempts = 1;
      const firstCloudStatus = result.response.status;

      if (remainingKeys.length === 0) {
        allCloudKeysQuotaLimited = result.response.status === 429;
      } else {
        log.warn(
          { status: result.response.status, fallback_keys: remainingKeys.length },
          "cloud returned retryable status, trying next keys",
        );
        for (const nextKey of remainingKeys) {
          const fallbackResult = await proxyToBackend({
            backend: "cloud",
            req,
            bodyBuffer,
            targetUrl: backendUrl("cloud", requestUrl, config, selfHostedBaseUrl),
            config,
            apiKey: nextKey,
          });
          totalAttempts += 1;
          if (
            fallbackResult.kind === "response" &&
            fallbackResult.response
          ) {
            if (fallbackResult.response.status === 429) {
              quotaLimitedAttempts += 1;
            }
            if (!RETRYABLE_CLOUD_STATUS.has(fallbackResult.response.status)) {
              fallbackUsed = true;
              fallbackReason = `primary cloud key failed with ${firstCloudStatus}, next key succeeded`;
              result = fallbackResult;
              break;
            }
          }
          result = fallbackResult;
        }
        allCloudKeysQuotaLimited =
          quotaLimitedAttempts === totalAttempts &&
          totalAttempts === cloudApiKeys.length;
      }
    }

    if (
      allCloudKeysQuotaLimited &&
      result.backend === "cloud" &&
      result.kind === "response" &&
      result.response?.status === 429 &&
      isCloudQuotaFallbackAllowed(routeMode, needsCloud)
    ) {
      fallbackUsed = true;
      fallbackReason = `all ${cloudApiKeys.length} cloud API key(s) returned 429; falling back to self-hosted`;
      log.warn(
        { fallback_reason: fallbackReason },
        "falling back from cloud to self-hosted",
      );
      result = await proxyToBackend({
        backend: "self-hosted",
        req,
        bodyBuffer,
        targetUrl: backendUrl("self-hosted", requestUrl, config, selfHostedBaseUrl),
        config,
      });
    }

    const statusCode =
      result.kind === "network-error" ? 502 : result.response?.status || 502;
    await appendAuditEntry({
      backendUsed: result.backend,
      statusCode,
      fallbackUsed,
      fallbackReason: fallbackReason || needsCloud.reason || "",
    });
    await sendProxyResponse(res, result, { fallbackUsed, fallbackReason });
  };
}
