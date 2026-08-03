import type { Request, Response } from "express";
import { Readable } from "node:stream";
import type { AuditStore } from "./audit-store";
import type { GatewayConfig, ProxyResult, AuditEntry } from "./types";
import * as quotaService from "./quota/service";
import type { QuotaRejection, QuotaReservation } from "./quota/types";
import {
  chooseInitialBackend,
  getRouteMode,
  hasSensitiveHeaders,
  isFallbackAllowed,
  isFallbackEligible,
  isCloudQuotaFallbackAllowed,
  isSupportedFirecrawlPath,
  requestNeedsCloud,
  tokenScopeAllowsPath,
  validateGatewayRequest,
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
import * as credentialRepository from "./credentials/repository";
import * as userService from "./users/service";
import * as settingsService from "./settings/service";
import * as accountRepository from "./db/accounts";
import * as sourceRepository from "./sources/repository";
import type { ResolvedSource } from "./sources/repository";
import { getRequestLogger } from "./logger";
import { decryptSettingValue } from "./settings/crypto";
import { completeGatewayJob, createGatewayJob, getGatewayJob } from "./jobs/gateway-jobs";
import { classifyAsyncRoute, replaceAsyncRouteId, type AsyncRoute } from "./jobs/routes";
import { virtualizeCreationResponse } from "./jobs/virtualize";

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
      // Legacy values are read-only during the explicit conversion window.
      // Do not mutate settings on proxy traffic; conversion is operator-run.
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

/** Returns null after cancelling an oversized upstream body without retaining it in memory. */
async function readBoundedResponseBody(response: globalThis.Response, maxBytes: number): Promise<Buffer | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already being rejected; cancellation is best effort.
    }
    return null;
  }
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    return body.length <= maxBytes ? body : null;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The response is already being rejected; cancellation is best effort.
        }
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

async function proxyToBackend({
  backend,
  req,
  bodyBuffer,
  targetUrl,
  config,
  apiKey,
  source,
  bufferSuccess = false,
  successBufferMaxBytes,
  onIncludedDispatch,
}: {
  backend: string;
  req: Request;
  bodyBuffer: Buffer;
  targetUrl: string;
  config: GatewayConfig;
  apiKey?: string;
  source?: ResolvedSource;
  /** Buffer a successful response only when its body must be safely rewritten. */
  bufferSuccess?: boolean;
  /** Buffer a known-small successful status response for terminal-state bookkeeping. */
  successBufferMaxBytes?: number;
  /** Atomically reserve an included-quota slot before dispatching to operator infrastructure. */
  onIncludedDispatch?: (source: ResolvedSource) => Promise<ProxyResult | null>;
}): Promise<ProxyResult> {
  const releaseSource = source ? sourceRepository.tryAcquireSource(source) : () => undefined;
  if (!releaseSource) {
    return {
      kind: "network-error",
      backend,
      error: new Error("Selected source is at its concurrency limit"),
      body: Buffer.from(JSON.stringify({ success: false, error: "Selected source is at its concurrency limit" })),
      sourceId: source?.id,
      credentialId: source?.credentialId,
      fundingType: source?.fundingType,
      durationMs: 0,
      preDispatchFailure: true,
    };
  }
  // Included infrastructure is chargeable: reserve before any upstream fetch so
  // concurrent requests can never overspend the account or platform counters.
  if (source?.fundingType === "included" && onIncludedDispatch) {
    let rejection: ProxyResult | null;
    try {
      rejection = await onIncludedDispatch(source);
    } catch (error) {
      // An unexpected quota failure must not leak the acquired source slot;
      // the try/finally below only covers the upstream dispatch.
      releaseSource();
      throw error;
    }
    if (rejection) {
      // No upstream dispatch happened: the slot must be returned or the source
      // will appear saturated after a burst of rejected requests.
      releaseSource();
      return rejection;
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), source?.requestTimeoutMs ?? config.requestTimeoutMs);
  const started = Date.now();
  let streamingResponse = false;
  let upstreamDispatchStarted = false;

  try {
    upstreamDispatchStarted = true;
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: sanitizeHeaders(req.headers, backend, apiKey, config.authEnabled),
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuffer,
      redirect: "manual",
      signal: controller.signal,
    });

    const successfulResponse = response.ok || response.status < 400;
    const contentLength = Number(response.headers.get("content-length"));
    const bufferBoundedStatus = successBufferMaxBytes !== undefined &&
      Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= successBufferMaxBytes;
    // Successful responses normally stream directly to the client. Classified
    // async creations are the sole exception: their IDs must be rewritten before
    // a tenant can observe them. A known-small status response may be buffered
    // solely to record an unambiguous terminal state.
    if (successfulResponse && response.body && !bufferSuccess && !bufferBoundedStatus) {
      streamingResponse = true;
      return {
        kind: "response",
        backend,
        response,
        stream: response.body,
        cleanup: () => {
          clearTimeout(timeout);
          releaseSource();
        },
        sourceId: source?.id,
        credentialId: source?.credentialId,
        fundingType: source?.fundingType,
        durationMs: Date.now() - started,
        dispatched: true,
      };
    }

    const bufferLimit = successfulResponse && bufferBoundedStatus
      ? Math.min(successBufferMaxBytes!, source?.responseBufferMaxBytes ?? config.maxBodyBytes)
      : source?.responseBufferMaxBytes ?? config.maxBodyBytes;
    const body = await readBoundedResponseBody(response, bufferLimit);
    if (body === null) {
      return {
        kind: "network-error",
        backend,
        error: new Error("Upstream response exceeds the gateway buffer limit"),
        body: Buffer.from(JSON.stringify({ success: false, error: "Upstream response exceeds the gateway buffer limit" })),
        sourceId: source?.id,
        credentialId: source?.credentialId,
        fundingType: source?.fundingType,
        durationMs: Date.now() - started,
        dispatched: true,
      };
    }
    return {
      kind: "response",
      backend,
      response,
      body,
      sourceId: source?.id,
      credentialId: source?.credentialId,
      fundingType: source?.fundingType,
      durationMs: Date.now() - started,
      dispatched: true,
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
      sourceId: source?.id,
      credentialId: source?.credentialId,
      fundingType: source?.fundingType,
      durationMs: Date.now() - started,
      dispatched: true,
    };
  } finally {
    if (upstreamDispatchStarted && source?.fundingType === "byok" && source.credentialId) {
      try {
        await credentialRepository.touchCredential(source.credentialId);
      } catch {
        // Last-use metadata is best effort and must not change the upstream result.
      }
    }
    // Streamed responses keep the timeout alive and source reservation held until their body completes.
    if (!streamingResponse) {
      clearTimeout(timeout);
      releaseSource();
    }
  }
}

function backendUrl(
  backend: string,
  originalUrl: string,
  config: GatewayConfig,
  selfHostedBaseUrl: string,
  sourceBaseUrl?: string,
): string {
  const base = sourceBaseUrl || (backend === "cloud" ? config.cloudBaseUrl : selfHostedBaseUrl);
  return `${base}${originalUrl}`;
}

async function sendProxyResponse(
  res: Response,
  result: ProxyResult,
  meta: { fallbackUsed: boolean; fallbackReason: string; quota?: QuotaReservation | null },
): Promise<void> {
  if (result.kind === "network-error") {
    res.status(result.statusCode || 502).set({
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
  if (result.fundingType) {
    headers["x-hybrid-firecrawl-funding"] = result.fundingType;
  }
  if (meta.quota) {
    headers["x-quota-limit"] = String(meta.quota.limit);
    headers["x-quota-remaining"] = String(meta.quota.remaining);
    headers["x-quota-reset"] = meta.quota.resetAt;
  }
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
const ASYNC_STATUS_BUFFER_MAX_BYTES = 64 * 1024;

function gatewayErrorResult(backend: string, error: string, fundingType?: "byok" | "included"): ProxyResult {
  return {
    kind: "network-error",
    backend,
    error: new Error(error),
    body: Buffer.from(JSON.stringify({ success: false, error })),
    fundingType,
    durationMs: 0,
  };
}

/** Stable machine-readable quota rejection delivered through the normal proxy path. */
function quotaErrorResult(rejection: QuotaRejection, fundingType?: "byok" | "included"): ProxyResult {
  return {
    kind: "network-error",
    backend: "none",
    error: new Error(rejection.message),
    body: Buffer.from(JSON.stringify({ success: false, error: rejection.message, code: rejection.code })),
    statusCode: rejection.statusCode,
    fundingType,
    durationMs: 0,
  };
}

function creationDiagnostics(method: string, pathname: string, body: Buffer, json: unknown): Record<string, unknown> {
  const jsonFields = json && typeof json === "object" && !Array.isArray(json)
    ? Object.keys(json as Record<string, unknown>).slice(0, 20)
    : [];
  return { method, path: pathname, body_bytes: body.length, json_fields: jsonFields };
}

function isSuccessfulResponse(result: ProxyResult): boolean {
  const status = result.kind === "response" ? result.response?.status : undefined;
  return status !== undefined && status >= 200 && status < 300;
}

function hasTerminalAsyncStatus(body: Buffer | undefined): boolean {
  if (!body || body.length > ASYNC_STATUS_BUFFER_MAX_BYTES) return false;
  try {
    const value = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const nested = value.data && typeof value.data === "object" && !Array.isArray(value.data)
      ? value.data as Record<string, unknown>
      : undefined;
    const status = typeof value.status === "string" ? value.status : nested?.status;
    return typeof status === "string" && ["completed", "failed", "cancelled"].includes(status.toLowerCase());
  } catch {
    return false;
  }
}

type TenantProxyRequest = Request & { tenantEndpointId?: string };

export function createProxyHandler({
  config,
  auditStore,
  getTrustedUserId,
  getTrustedAccountId,
  resolveEndpoint = accountRepository.getAccountByPublicId,
  resolveSources,
}: {
  config: GatewayConfig;
  auditStore: AuditStore;
  getTrustedUserId?: (req: Request) => string | undefined;
  getTrustedAccountId?: (req: Request) => string | undefined;
  resolveEndpoint?: typeof accountRepository.getAccountByPublicId;
  resolveSources?: (
    accountId: string,
    preference: "byok" | "included" | "auto",
  ) => Promise<ResolvedSource[]>;
}) {
  const sourceResolver = resolveSources ?? ((accountId, preference) =>
    sourceRepository.resolveInfrastructureSources(
      accountId,
      preference,
      config.providerCredentialsEncryptionKey ?? config.firecrawlKeysEncryptionKey,
      config.cloudBaseUrl,
    ));
  return async function handleProxy(
    req: Request,
    res: Response,
  ): Promise<void> {
    const trustedUserId = getTrustedUserId?.(req);
    const trustedAccountId = getTrustedAccountId?.(req);
    const log = getRequestLogger(req);
    const started = Date.now();
    const tenantEndpointId = (req as TenantProxyRequest).tenantEndpointId;
    res.set?.("x-firecrawl-gateway-route", tenantEndpointId ? "tenant" : "legacy");
    if (!tenantEndpointId) res.set?.("deprecation", "true");
    // A mounted tenant route exposes only the upstream /v1 or /v2 suffix in
    // req.url. Legacy root routes retain their original URL unchanged.
    const requestUrl = tenantEndpointId ? req.url : req.originalUrl || req.url;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(requestUrl, "http://gateway.local");
    } catch {
      res.status(400).json({ success: false, error: "Invalid request URL" });
      return;
    }
    let userId: string | undefined;
    let accountId: string | undefined = trustedAccountId;
    let gatewayTokenScopes: string[] | undefined;
    let tenantFundingPreference: "byok" | "included" | "auto" | undefined;
    let tenantSources: ResolvedSource[] = [];
    let quotaReservation: QuotaReservation | null = null;
    let includedDispatched = false;
    const quotaRequestId = req.quotaRequestId || cryptoRandomId();
    let asyncRoute: AsyncRoute | null = null;
    let lifecycleJob: Awaited<ReturnType<typeof getGatewayJob>> = null;
    let primaryTargetUrl = "";
    let routeMode: string = config.defaultRouteMode;
    const appendAuditEntry = async ({
      backendUsed,
      fundingType,
      statusCode,
      fallbackUsed = false,
      fallbackReason = "",
    }: {
      backendUsed: string;
      statusCode: number;
      fallbackUsed?: boolean;
      fallbackReason?: string;
      fundingType?: "byok" | "included" | "unknown";
    }): Promise<void> => {
      const auditEntry: AuditEntry = {
        id: cryptoRandomId(),
        created_at: nowIso(),
        method: req.method,
        path: parsedUrl.pathname,
        route_mode: routeMode,
        backend_used: backendUsed,
        funding_type: fundingType,
        fallback_used: fallbackUsed,
        fallback_reason: fallbackReason,
        status_code: statusCode,
        duration_ms: Date.now() - started,
        // Target URLs may contain customer data, signed query strings, or
        // private-network details. Keep them out of both PostgreSQL and
        // compatibility log output.
        target_url: primaryTargetUrl ? "[redacted]" : "",
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

    // Tenant routes always require a gateway token, even if legacy root routes
    // are running with product authentication disabled.
    if ((config.authEnabled || tenantEndpointId) && !trustedUserId) {
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
      gatewayTokenScopes = validKey.scopes;
      void Promise.resolve(apiKeyService.touchApiKey(validKey.id)).catch((err) => {
        log.warn({ err }, "Failed to update API key last used timestamp");
      });
    } else if (trustedUserId) {
      userId = trustedUserId;
    }

    if (tenantEndpointId) {
      // Do not resolve endpoint IDs until after token authentication. A failed
      // account match intentionally uses the same opaque response as a missing
      // endpoint so neither resource can be enumerated.
      const endpoint = await resolveEndpoint(tenantEndpointId);
      if (!endpoint || endpoint.id !== accountId || endpoint.status !== "active") {
        await appendAuditEntry({
          backendUsed: "none",
          statusCode: 404,
          fallbackReason: "Tenant endpoint unavailable",
        });
        res.status(404).json({ success: false, error: "Tenant endpoint unavailable" });
        return;
      }
      tenantFundingPreference = endpoint.funding_preference ?? "auto";
      asyncRoute = classifyAsyncRoute(req.method, parsedUrl.pathname);
      if (asyncRoute?.kind === "lifecycle") {
        lifecycleJob = await getGatewayJob(endpoint.id, asyncRoute.publicId!);
        if (!lifecycleJob || lifecycleJob.route_family !== asyncRoute.family) {
          await appendAuditEntry({ backendUsed: "none", statusCode: 404, fallbackReason: "Tenant async job unavailable" });
          res.status(404).json({ success: false, error: "Tenant async job unavailable" });
          return;
        }
      }
      try {
        tenantSources = await sourceResolver(endpoint.id, tenantFundingPreference);
      } catch (error) {
        if (lifecycleJob) {
          log.warn({ err: error }, "Unable to resolve recorded infrastructure source");
          await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "Recorded job source unavailable" });
          res.status(503).json({ success: false, error: "Recorded job source unavailable" });
          return;
        }
        if (asyncRoute?.kind === "create") {
          log.warn({ err: error }, "Unable to resolve a managed source for tenant async job creation");
          await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "Managed source unavailable for tenant async job" });
          res.status(503).json({ success: false, error: "Managed source unavailable for tenant async job" });
          return;
        }
        // Legacy settings remain a dual-read fallback during the migration window.
        log.warn({ err: error }, "Unable to resolve infrastructure sources; authenticated account will fail closed");
      }
      if (lifecycleJob) {
        const pinnedSource = tenantSources.find((source) =>
          source.id === lifecycleJob!.source_id &&
          (!lifecycleJob!.credential_id || source.credentialId === lifecycleJob!.credential_id),
        );
        if (!pinnedSource) {
          await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "Recorded job source unavailable" });
          res.status(503).json({ success: false, error: "Recorded job source unavailable" });
          return;
        }
        tenantSources = [pinnedSource];
      }
      if (asyncRoute?.kind === "create" && tenantSources.length === 0) {
        await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "Managed source unavailable for tenant async job" });
        res.status(503).json({ success: false, error: "Managed source unavailable for tenant async job" });
        return;
      }
    } else if (accountId) {
      // Legacy /v1|/v2 root routes are tenant-aware too: the account's funding
      // preference and infrastructure sources apply, so included traffic can
      // never bypass quota by using the deprecated surface. Authenticated
      // accounts without resolvable sources fail closed below.
      try {
        const account = await accountRepository.getAccountById(accountId);
        if (account) {
          tenantFundingPreference = account.funding_preference ?? "auto";
          tenantSources = await sourceResolver(accountId, tenantFundingPreference);
        }
      } catch (error) {
        log.warn({ err: error }, "Unable to resolve account infrastructure sources; authenticated account will fail closed");
      }
    }

    if (tenantFundingPreference === "byok" && !lifecycleJob && !tenantSources.some((source) => source.kind === "cloud" && source.credential)) {
      await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "No active BYOK credential source" });
      res.status(503).json({ success: false, error: "No active BYOK credential source" });
      return;
    }
    // Included funding must never silently fall back to user BYOK credentials;
    // it requires operator infrastructure and an account entitlement (checked
    // atomically at reservation time).
    if (
      tenantFundingPreference === "included" &&
      !lifecycleJob &&
      !tenantSources.some((source) => source.fundingType === "included")
    ) {
      await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "No included infrastructure source available" });
      res.status(503).json({
        success: false,
        error: "No included infrastructure source available",
        code: "no_entitlement",
      });
      return;
    }

    // Atomically reserve one included-quota slot before any dispatch to
    // operator infrastructure; retries and fallbacks share the reservation.
    const onIncludedDispatch = async (): Promise<ProxyResult | null> => {
      if (!accountId) return null;
      if (!quotaReservation) {
        const outcome = await quotaService.reserveIncluded(accountId, quotaRequestId);
        if ("code" in outcome) return quotaErrorResult(outcome, "included");
        quotaReservation = outcome;
      }
      includedDispatched = true;
      return null;
    };

    if (!isSupportedFirecrawlPath(parsedUrl.pathname)) {
      await appendAuditEntry({ backendUsed: "none", statusCode: 404, fallbackReason: "Unsupported Firecrawl path" });
      res.status(404).json({ success: false, error: "Only /v1/* and /v2/* are supported" });
      return;
    }
    // Scope enforcement applies to both tenant and deprecated legacy routes.
    // A legacy URL changes the endpoint selection mechanism, never a token's
    // route-family capability.
    if (gatewayTokenScopes && !tokenScopeAllowsPath(gatewayTokenScopes, parsedUrl.pathname)) {
      await appendAuditEntry({ backendUsed: "none", statusCode: 403, fallbackReason: "Gateway token scope denied" });
      res.status(403).json({ success: false, error: "Gateway token scope does not allow this route" });
      return;
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
    const requestRejection = validateGatewayRequest(parsedUrl.pathname, json);
    if (requestRejection) {
      await appendAuditEntry({
        backendUsed: "none",
        statusCode: requestRejection.statusCode,
        fallbackReason: requestRejection.reason,
      });
      res.status(requestRejection.statusCode).json({ success: false, error: requestRejection.reason });
      return;
    }
    const upstreamRequestUrl = asyncRoute?.kind === "lifecycle"
      ? `${replaceAsyncRouteId(asyncRoute, lifecycleJob!.upstream_job_id)}${parsedUrl.search}`
      : requestUrl;
    const targetUrls = collectTargetUrls(json);
    primaryTargetUrl = targetUrls[0] || "";
    const privacyHeaders = headersForPrivacyCheck(req.headers, config.authEnabled);
    const privacy = {
      hasSensitiveHeaders: hasSensitiveHeaders(privacyHeaders, json),
      hasPrivateTargetUrl: hasPrivateTargetUrl(targetUrls),
    };
    const needsCloud = requestNeedsCloud(parsedUrl.pathname, json);
    // BYOK credentials fund Cloud only. Never satisfy an explicit BYOK choice
    // with a shared self-hosted/included source merely because its route mode
    // would otherwise prefer self-hosted.
    const isPinnedLifecycle = Boolean(lifecycleJob);
    const isManagedAsyncCreation = tenantEndpointId !== undefined && asyncRoute?.kind === "create";
    const initialBackend = isPinnedLifecycle
      ? tenantSources[0].kind === "cloud" ? "cloud" : "self-hosted"
      : tenantFundingPreference === "byok"
        ? "cloud"
        : chooseInitialBackend(routeMode, needsCloud);
    const cloudSources = tenantSources.filter((source) => source.kind === "cloud" && source.credential);
    const selfHostedSource = tenantSources.find((source) => source.kind === "self_hosted");
    const cloudSourceByCredential = new Map(
      cloudSources.map((source) => [source.credential!, source]),
    );
    let cloudApiKeys: string[] = cloudSources.map((source) => source.credential!);
    if (
      !isPinnedLifecycle &&
      !isManagedAsyncCreation &&
      !accountId &&
      cloudApiKeys.length === 0 &&
      (initialBackend === "cloud" ||
        (initialBackend === "self-hosted" && routeMode !== "self-hosted-only" && isFallbackAllowed(routeMode, privacy)))
    ) {
      // Explicit dual-read window: new sources take priority and legacy
      // encrypted settings preserve existing integrations until conversion.
      cloudApiKeys = await getCloudApiKeys(config);
    }
    const primaryCloudApiKey = cloudApiKeys[0];
    const primaryCloudSource = primaryCloudApiKey ? cloudSourceByCredential.get(primaryCloudApiKey) : undefined;

    if (
      isManagedAsyncCreation &&
      ((initialBackend === "cloud" && !primaryCloudSource) ||
        (initialBackend === "self-hosted" && !selfHostedSource))
    ) {
      await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "Managed source unavailable for tenant async job" });
      res.status(503).json({ success: false, error: "Managed source unavailable for tenant async job" });
      return;
    }

    // Authenticated accounts must use an explicitly resolved source. Never
    // substitute the legacy global Cloud/self-hosted settings for a missing
    // account source: the resulting source has no funding provenance and would
    // bypass included-quota reservation.
    if (
      accountId &&
      !isPinnedLifecycle &&
      ((initialBackend === "cloud" && !primaryCloudSource) ||
        (initialBackend === "self-hosted" && !selfHostedSource))
    ) {
      await appendAuditEntry({ backendUsed: "none", statusCode: 503, fallbackReason: "No active infrastructure source" });
      res.status(503).json({
        success: false,
        error: "No active infrastructure source available for this account",
        code: "no_entitlement",
      });
      return;
    }

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
      targetUrl: backendUrl(
        initialBackend,
        upstreamRequestUrl,
        config,
        selfHostedBaseUrl,
        initialBackend === "cloud" ? primaryCloudSource?.baseUrl : selfHostedSource?.baseUrl,
      ),
      config,
      apiKey: initialBackend === "cloud" ? primaryCloudApiKey : undefined,
      source: initialBackend === "cloud" ? primaryCloudSource : selfHostedSource,
      onIncludedDispatch,
      bufferSuccess: tenantEndpointId !== undefined && asyncRoute?.kind === "create",
      successBufferMaxBytes: tenantEndpointId !== undefined && asyncRoute?.kind === "lifecycle" && req.method.toUpperCase() === "GET"
        ? ASYNC_STATUS_BUFFER_MAX_BYTES
        : undefined,
    });
    let fallbackUsed = false;
    let fallbackReason = "";

    if (
      !isPinnedLifecycle &&
      initialBackend === "self-hosted" &&
      Boolean(primaryCloudApiKey) &&
      !result.statusCode &&
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
        targetUrl: backendUrl("cloud", upstreamRequestUrl, config, selfHostedBaseUrl, primaryCloudSource?.baseUrl),
        config,
        apiKey: primaryCloudApiKey,
        source: primaryCloudSource,
        onIncludedDispatch,
        bufferSuccess: tenantEndpointId !== undefined && asyncRoute?.kind === "create",
        successBufferMaxBytes: tenantEndpointId !== undefined && asyncRoute?.kind === "lifecycle" && req.method.toUpperCase() === "GET"
          ? ASYNC_STATUS_BUFFER_MAX_BYTES
          : undefined,
      });
    }

    // Try next cloud API keys on auth/rate-limit errors
    let allCloudKeysQuotaLimited = false;
    if (
      !isPinnedLifecycle &&
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
            targetUrl: backendUrl(
              "cloud",
              upstreamRequestUrl,
              config,
              selfHostedBaseUrl,
              cloudSourceByCredential.get(nextKey)?.baseUrl,
            ),
            config,
            apiKey: nextKey,
            source: cloudSourceByCredential.get(nextKey),
            onIncludedDispatch,
            bufferSuccess: tenantEndpointId !== undefined && asyncRoute?.kind === "create",
            successBufferMaxBytes: tenantEndpointId !== undefined && asyncRoute?.kind === "lifecycle" && req.method.toUpperCase() === "GET"
              ? ASYNC_STATUS_BUFFER_MAX_BYTES
              : undefined,
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
      !isPinnedLifecycle &&
      allCloudKeysQuotaLimited &&
      result.backend === "cloud" &&
      result.kind === "response" &&
      result.response?.status === 429 &&
      isCloudQuotaFallbackAllowed(routeMode, needsCloud) &&
      (!accountId || Boolean(selfHostedSource)) &&
      (!isManagedAsyncCreation || Boolean(selfHostedSource))
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
        targetUrl: backendUrl("self-hosted", upstreamRequestUrl, config, selfHostedBaseUrl, selfHostedSource?.baseUrl),
        config,
        source: selfHostedSource,
        onIncludedDispatch,
        bufferSuccess: tenantEndpointId !== undefined && asyncRoute?.kind === "create",
        successBufferMaxBytes: tenantEndpointId !== undefined && asyncRoute?.kind === "lifecycle" && req.method.toUpperCase() === "GET"
          ? ASYNC_STATUS_BUFFER_MAX_BYTES
          : undefined,
      });
    }

    if (isManagedAsyncCreation && result.kind === "response" && result.response && result.response.status < 400) {
      if (!isSuccessfulResponse(result) || !result.body) {
        result = gatewayErrorResult(result.backend, "Gateway could not safely virtualize the async job response", result.fundingType);
      } else {
        const publicJobId = cryptoRandomId();
        const publicUrl = `/e/${encodeURIComponent(tenantEndpointId)}${asyncRoute!.family}/${encodeURIComponent(publicJobId)}`;
        const virtualized = virtualizeCreationResponse(result.body, publicJobId, publicUrl);
        if (!virtualized) {
          result = gatewayErrorResult(result.backend, "Gateway could not safely virtualize the async job response", result.fundingType);
        } else {
          try {
            await createGatewayJob(accountId!, {
              publicJobId,
              upstreamJobId: virtualized.upstreamJobId,
              routeFamily: asyncRoute!.family,
              sourceId: result.sourceId,
              credentialId: result.credentialId,
              // Legacy-setting dispatches predate source records and are retained
              // only for the conversion window; all resolved sources carry this.
              fundingType: result.fundingType ?? "included",
              creationRequest: creationDiagnostics(req.method, parsedUrl.pathname, bodyBuffer, json),
            });
            result = { ...result, body: virtualized.body };
          } catch (error) {
            log.error({ err: error }, "Unable to persist virtual async job mapping");
            result = gatewayErrorResult(result.backend, "Gateway could not persist the async job response", result.fundingType);
          }
        }
      }
    }

    if (
      tenantEndpointId &&
      asyncRoute?.kind === "lifecycle" &&
      isSuccessfulResponse(result) &&
      (req.method.toUpperCase() === "DELETE" ||
        (req.method.toUpperCase() === "GET" && hasTerminalAsyncStatus(result.body)))
    ) {
      try {
        await completeGatewayJob(accountId!, asyncRoute.publicId!);
      } catch (error) {
        // The upstream cancellation succeeded. Do not turn it into a client
        // failure, but retain an operator-visible record of the missed update.
        log.warn({ err: error }, "Unable to mark cancelled gateway job complete");
      }
    }

    // Charge exactly once when any operator-infrastructure dispatch occurred;
    // release when the request never reached an included upstream. Fallbacks
    // and key-rotation retries stay attached to the same reservation.
    // (Fresh-typed alias: closure-assigned variables get over-narrowed by TS.)
    const pendingReservation = ((): QuotaReservation | null => quotaReservation)();
    if (includedDispatched) {
      if (pendingReservation) {
        await quotaService.finalizeReservation(pendingReservation.reservationId).catch((error) => {
          log.error({ err: error, requestId: pendingReservation.reservationId }, "Unable to finalize included quota reservation");
        });
      }
    } else if (pendingReservation) {
      await quotaService.releaseReservation(pendingReservation.reservationId).catch((error) => {
        log.warn({ err: error, requestId: pendingReservation.reservationId }, "Unable to release included quota reservation");
      });
    }

    if (result.preDispatchFailure && result.sourceId) {
      void quotaService.emitSourcePressure(result.sourceId, "source concurrency limit").catch(() => undefined);
    }

    const statusCode =
      result.kind === "network-error" ? result.statusCode || 502 : result.response?.status || 502;
    await appendAuditEntry({
      backendUsed: result.backend,
      fundingType: result.fundingType ?? "unknown",
      statusCode,
      fallbackUsed,
      fallbackReason: fallbackReason || needsCloud.reason || "",
    });
    await sendProxyResponse(res, result, { fallbackUsed, fallbackReason, quota: quotaReservation });
  };
}
