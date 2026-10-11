import { Inject, Injectable, Logger } from "@nestjs/common";
import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import type {
  AuditEntry,
  Backend,
  CloudKeyEntry,
  NeedsCloudResult,
  ProxyResult,
  RequestWithContext,
} from "../common/types";
import {
  cryptoRandomId,
  collectTargetUrls,
  hasPrivateTargetUrl,
  inspectBody,
  nowIso,
} from "../common/utils";
import {
  DEFAULT_ROUTE_MODE,
  chooseInitialBackend,
  hasSensitiveHeaders,
  isCloudQuotaFallbackAllowed,
  isFallbackAllowed,
  isFallbackEligible,
  isSelfHostedUnavailable,
  mayUseCloudKeys,
  requestNeedsCloud,
  selectKeyPools,
  type PrivacyFlags,
  type RouteMode,
} from "./policy";
import { SettingsService, parseRouteMode, type SettingRecord } from "../settings/settings.service";
import { loadCloudKeyEntries } from "../settings/cloud-keys";
import { ApiKeysService, isApiKeyExpired } from "../api-keys/api-keys.service";
import { AuditService } from "../audit/audit.service";
import { MetricsService } from "../metrics/metrics.service";
import { CircuitBreaker } from "./circuit-breaker";
import {
  CreditRoutingService,
  estimateCreditCost,
  extractCreditsUsed,
  observeCreditsUsedStream,
  type CreditReservation,
} from "../credits/credit-routing.service";

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
const PROXY_SETTING_KEYS = ["default_route_mode", "firecrawl_api_keys"] as const;
const RETRYABLE_CLOUD_STATUS = new Set([401, 402, 403, 429]);
const CLOUD_CAPACITY_STATUS = new Set([402, 429]);

type ProxySettings = Record<(typeof PROXY_SETTING_KEYS)[number], SettingRecord | null>;

/** Per-request state shared by the proxy stages. */
interface ProxyContext {
  request: RequestWithContext;
  reply: FastifyReply;
  started: number;
  /** Path of the request as the client sent it, used for policy and the audit entry. */
  path: string;
  /** Path and query forwarded upstream (the legacy `routeMode` parameter removed). */
  upstreamUrl: string;
  routeMode: RouteMode;
  primaryTargetUrl: string;
  /** Set once the virtual API key validates; stays null for playground and rejected requests. */
  apiKeyId: string | null;
}

/** What a request needs once it passed validation and the routing decision. */
interface RoutePlan {
  bodyBuffer: Buffer;
  needsCloud: NeedsCloudResult;
  privacy: PrivacyFlags;
  initialBackend: Backend;
  /** The pool Cloud is currently tried with; swapped for `fallbackApiKeys` once those take over. */
  cloudApiKeys: string[];
  /** Hybrid reserve: taken over once, when Cloud credit is out and only these keys can still answer. */
  fallbackApiKeys: string[];
  /** Set once self-hosted has answered, so a Cloud quota failure never sends the request back. */
  selfHostedAttempted: boolean;
  /**
   * Set when any upstream call was really made (Cloud or self-hosted), even if a
   * later short-circuited result is the one sent back. Feeds the fallback window.
   */
  upstreamAttempted: boolean;
  estimatedCredits: number;
  attemptedCloudKeyIds: Set<string>;
}

interface CloudAttempt {
  result: ProxyResult;
  reservation: CreditReservation;
}

/** The response that will be sent, and how routing arrived at it. */
interface Outcome {
  result: ProxyResult;
  fallbackUsed: boolean;
  fallbackReason: string;
}

// `routeMode` was once a client override; it is no longer honored, so do not forward it upstream.
function withoutRouteModeParam(originalUrl: string, parsedUrl: URL): string {
  if (!parsedUrl.searchParams.has("routeMode")) return originalUrl;
  const next = new URL(parsedUrl);
  next.searchParams.delete("routeMode");
  return `${next.pathname}${next.search}`;
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function circuitOpenResult(): ProxyResult {
  const message = "Self-hosted Firecrawl is temporarily unavailable (circuit open)";
  return {
    kind: "network-error",
    backend: "self-hosted",
    error: new Error(message),
    body: Buffer.from(JSON.stringify({ success: false, error: message })),
    durationMs: 0,
  };
}

@Injectable()
export class ProxyService {
  private readonly logger = new Logger(ProxyService.name);
  private cloudKeysCache: { value: string; entries: CloudKeyEntry[] } | null = null;
  private lastCloudKeysFailure: string | null = null;
  private readonly selfHostedBreaker: CircuitBreaker;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly settings: SettingsService,
    private readonly keys: ApiKeysService,
    private readonly audit: AuditService,
    private readonly credits: CreditRoutingService,
    private readonly metrics: MetricsService,
  ) {
    this.selfHostedBreaker = new CircuitBreaker({
      failureThreshold: config.selfHostedBreakerFailureThreshold,
      cooldownMs: config.selfHostedBreakerCooldownMs,
      onTransition: (from, to) => {
        this.metrics.recordCircuitTransition(to);
        this.logger.warn(`Self-hosted circuit breaker ${from} -> ${to}`);
      },
      onReject: () => this.metrics.recordCircuitRejected(),
    });
  }

  async handle(
    request: RequestWithContext,
    reply: FastifyReply,
    originalUrl = request.raw.url || request.url,
  ): Promise<void> {
    const ctx = this.createContext(request, reply, originalUrl);
    if (!ctx) return;
    const settings = await this.authenticate(ctx);
    if (!settings) return;
    const plan = await this.buildPlan(ctx, settings);
    if (!plan) return;
    const outcome = await this.dispatch(ctx, plan);
    if (!outcome) return;
    if (await this.rotateCloudKeys(ctx, plan, outcome))
      await this.fallBackToSelfHosted(ctx, plan, outcome);
    if (await this.fallBackToFallbackKeys(ctx, plan, outcome))
      await this.rotateCloudKeys(ctx, plan, outcome);
    await this.respond(ctx, plan, outcome);
  }

  private createContext(
    request: RequestWithContext,
    reply: FastifyReply,
    originalUrl: string,
  ): ProxyContext | null {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(originalUrl, "http://gateway.local");
    } catch {
      reply.code(400).send({ success: false, error: "Invalid request URL" });
      return null;
    }
    return {
      request,
      reply,
      started: Date.now(),
      path: parsedUrl.pathname,
      upstreamUrl: withoutRouteModeParam(originalUrl, parsedUrl),
      routeMode: DEFAULT_ROUTE_MODE,
      primaryTargetUrl: "",
      apiKeyId: null,
    };
  }

  /**
   * Loads the settings, resolves the route mode and validates the virtual API
   * key. Returns null after sending a 401 when the caller is not allowed.
   */
  private async authenticate(ctx: ProxyContext): Promise<ProxySettings | null> {
    const { request } = ctx;
    // Settings and API-key validation are independent, so fetch them together.
    const needsAuth = this.config.authEnabled && !request.admin;
    const bearerMatch = needsAuth
      ? String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i)
      : null;
    const [settings, authenticated] = await Promise.all([
      this.settings.getSettings(PROXY_SETTING_KEYS),
      bearerMatch ? this.keys.validateApiKey(bearerMatch[1]) : null,
    ]);
    // Clients cannot choose the route mode; only the admin's default decides it.
    ctx.routeMode = parseRouteMode(settings.default_route_mode, DEFAULT_ROUTE_MODE);

    if (!needsAuth) return settings;
    if (!bearerMatch) {
      await this.rejectEarly(ctx, "none", 401, "Missing or invalid API key", {
        success: false,
        error: "Missing or invalid API key",
      });
      return null;
    }
    if (!authenticated) {
      await this.rejectEarly(ctx, "none", 401, "Invalid or revoked API key", {
        success: false,
        error: "Invalid or revoked API key",
      });
      return null;
    }
    ctx.apiKeyId = authenticated.id;
    // Expiry is read from the (briefly cached) record on every request, so it is exact.
    if (isApiKeyExpired(authenticated)) {
      await this.rejectEarly(ctx, "none", 401, "API key has expired", {
        success: false,
        error: "API key has expired",
      });
      return null;
    }
    if (authenticated.rate_limit_per_minute != null) {
      const limit = await this.keys.hitRateLimit(authenticated);
      if (limit?.exceeded) {
        ctx.reply.headers({
          "x-ratelimit-limit": String(limit.limit),
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil(limit.resetAt / 1000)),
          "retry-after": String(Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000))),
        });
        await this.rejectEarly(ctx, "none", 429, "API key rate limit exceeded", {
          success: false,
          error: "API key rate limit exceeded. Please try again later.",
        });
        return null;
      }
    }
    void this.keys.touchApiKey(authenticated.id).catch(() => undefined);
    return settings;
  }

  /**
   * Inspects the body and decides where the request goes first. Returns null
   * after sending a 400, 413, 502 or 409 when it cannot be routed at all.
   */
  private async buildPlan(ctx: ProxyContext, settings: ProxySettings): Promise<RoutePlan | null> {
    const { request } = ctx;
    const bodyBuffer = this.getBodyBuffer(request);
    if (bodyBuffer.length > this.config.maxBodyBytes) {
      await this.rejectEarly(ctx, "none", 413, "Request body is too large for gateway inspection", {
        success: false,
        error: "Request body is too large for gateway inspection",
      });
      return null;
    }
    const { json, parseError } = inspectBody(request.body, request.headers);
    if (parseError) {
      await this.rejectEarly(ctx, "none", 400, parseError, {
        success: false,
        error: "Invalid JSON body",
        details: parseError,
      });
      return null;
    }
    const targetUrls = collectTargetUrls(json);
    ctx.primaryTargetUrl = targetUrls[0] || "";
    const privacy: PrivacyFlags = {
      hasSensitiveHeaders: hasSensitiveHeaders(this.privacyHeaders(request), json),
      hasPrivateTargetUrl: hasPrivateTargetUrl(targetUrls),
    };
    const needsCloud = requestNeedsCloud(ctx.path, json);
    const firstBackend = chooseInitialBackend(ctx.routeMode, needsCloud);
    const keyEntries = mayUseCloudKeys(firstBackend, ctx.routeMode, privacy)
      ? await this.getCloudKeyEntries(settings.firecrawl_api_keys)
      : [];
    const { initialBackend, cloudApiKeys, fallbackApiKeys } = selectKeyPools(
      ctx.routeMode,
      firstBackend,
      needsCloud,
      keyEntries,
    );
    if (initialBackend === "cloud" && !cloudApiKeys.length) {
      await this.rejectEarly(ctx, "none", 502, "No Firecrawl Cloud API key configured", {
        success: false,
        error: "No Firecrawl Cloud API key configured. Add one in Settings.",
      });
      return null;
    }
    if (initialBackend === "reject") {
      await this.rejectEarly(ctx, "none", 409, needsCloud.reason, {
        success: false,
        error: "This request requires Firecrawl Cloud, but route mode is self-hosted-only.",
        reason: needsCloud.reason,
      });
      return null;
    }
    return {
      bodyBuffer,
      needsCloud,
      privacy,
      initialBackend,
      cloudApiKeys,
      fallbackApiKeys,
      selfHostedAttempted: false,
      upstreamAttempted: false,
      estimatedCredits: estimateCreditCost(ctx.path, json),
      attemptedCloudKeyIds: new Set<string>(),
    };
  }

  /**
   * Sends the request to its first backend, falling back once when policy
   * allows. Returns null after sending a 429 when no Cloud credit pool is left.
   */
  private async dispatch(ctx: ProxyContext, plan: RoutePlan): Promise<Outcome | null> {
    if (plan.initialBackend === "cloud") {
      const cloudAttempt = await this.proxyCloud(ctx, plan);
      if (cloudAttempt)
        return { result: cloudAttempt.result, fallbackUsed: false, fallbackReason: "" };
      if (!isCloudQuotaFallbackAllowed(ctx.routeMode, plan.needsCloud)) {
        // A Cloud-required hybrid request cannot go to self-hosted, so the reserve keys take it.
        const reserveAttempt = this.takeFallbackKeys(plan)
          ? await this.proxyCloud(ctx, plan)
          : null;
        if (reserveAttempt)
          return {
            result: reserveAttempt.result,
            fallbackUsed: true,
            fallbackReason: "No available Firecrawl Cloud credit pool; using fallback API key",
          };
        await this.rejectEarly(ctx, "cloud", 429, "No available Firecrawl Cloud credit pool", {
          success: false,
          error:
            "No available Firecrawl Cloud credit pool. Refresh credit usage or try again later.",
        });
        return null;
      }
      return {
        result: await this.proxySelfHosted(ctx, plan),
        fallbackUsed: true,
        fallbackReason: "No available Firecrawl Cloud credit pool; falling back to self-hosted",
      };
    }

    const result = await this.proxySelfHosted(ctx, plan);
    const outcome: Outcome = { result, fallbackUsed: false, fallbackReason: "" };
    if (
      plan.cloudApiKeys.length > 0 &&
      isFallbackEligible(result) &&
      isFallbackAllowed(ctx.routeMode, plan.privacy)
    ) {
      const cloudAttempt = await this.proxyCloud(ctx, plan);
      if (cloudAttempt) {
        outcome.result = cloudAttempt.result;
        outcome.fallbackUsed = true;
        outcome.fallbackReason =
          result.kind === "network-error"
            ? result.error?.message || "self-hosted network error"
            : `self-hosted returned ${result.response?.status}`;
      }
    }
    return outcome;
  }

  /**
   * While Cloud answers with an auth or capacity error, retries with the next
   * reservable key. Returns whether every attempted key was out of quota.
   */
  private async rotateCloudKeys(
    ctx: ProxyContext,
    plan: RoutePlan,
    outcome: Outcome,
  ): Promise<boolean> {
    const first = outcome.result;
    if (
      first.backend !== "cloud" ||
      first.kind !== "response" ||
      !first.response ||
      !RETRYABLE_CLOUD_STATUS.has(first.response.status)
    )
      return false;
    const firstStatus = first.response.status;
    let attempts = 1;
    let quotaAttempts = CLOUD_CAPACITY_STATUS.has(firstStatus) ? 1 : 0;
    while (true) {
      const next = await this.proxyCloud(ctx, plan);
      if (!next) break;
      attempts++;
      const status = next.result.kind === "response" ? next.result.response?.status : undefined;
      if (status !== undefined && CLOUD_CAPACITY_STATUS.has(status)) quotaAttempts++;
      outcome.result = next.result;
      if (status !== undefined && !RETRYABLE_CLOUD_STATUS.has(status)) {
        outcome.fallbackUsed = true;
        outcome.fallbackReason = `primary cloud key failed with ${firstStatus}, next key succeeded`;
        break;
      }
    }
    return quotaAttempts === attempts;
  }

  /** Last resort once every Cloud key is out of quota, when policy allows it. */
  private async fallBackToSelfHosted(
    ctx: ProxyContext,
    plan: RoutePlan,
    outcome: Outcome,
  ): Promise<void> {
    const { result } = outcome;
    if (
      plan.selfHostedAttempted ||
      result.backend !== "cloud" ||
      result.kind !== "response" ||
      !result.response ||
      !CLOUD_CAPACITY_STATUS.has(result.response.status) ||
      !isCloudQuotaFallbackAllowed(ctx.routeMode, plan.needsCloud)
    )
      return;
    outcome.fallbackUsed = true;
    outcome.fallbackReason = `all ${plan.cloudApiKeys.length} cloud API key(s) are unavailable (${result.response.status}); falling back to self-hosted`;
    outcome.result = await this.proxySelfHosted(ctx, plan);
  }

  /**
   * Hybrid reserve: the fallback keys answer when Cloud credit ran out on a
   * request only Cloud can serve, or when self-hosted failed after Cloud credit
   * ran out. Returns whether they replaced the outcome.
   */
  private async fallBackToFallbackKeys(
    ctx: ProxyContext,
    plan: RoutePlan,
    outcome: Outcome,
  ): Promise<boolean> {
    if (!plan.fallbackApiKeys.length) return false;
    const { result } = outcome;
    const cloudOutOfQuota =
      plan.needsCloud.required &&
      result.backend === "cloud" &&
      result.kind === "response" &&
      !!result.response &&
      CLOUD_CAPACITY_STATUS.has(result.response.status);
    const selfHostedFailed =
      result.backend === "self-hosted" &&
      isFallbackEligible(result) &&
      isFallbackAllowed(ctx.routeMode, plan.privacy);
    if (!cloudOutOfQuota && !selfHostedFailed) return false;
    this.takeFallbackKeys(plan);
    const attempt = await this.proxyCloud(ctx, plan);
    if (!attempt) return false;
    outcome.result = attempt.result;
    outcome.fallbackUsed = true;
    outcome.fallbackReason = cloudOutOfQuota
      ? `all cloud API key(s) are unavailable (${result.response?.status}); using fallback API key`
      : `${
          result.kind === "network-error"
            ? result.error?.message || "self-hosted network error"
            : `self-hosted returned ${result.response?.status}`
        }; using fallback API key`;
    return true;
  }

  /** Makes the reserve the active pool; false when there is none left. */
  private takeFallbackKeys(plan: RoutePlan): boolean {
    if (!plan.fallbackApiKeys.length) return false;
    plan.cloudApiKeys = plan.fallbackApiKeys;
    plan.fallbackApiKeys = [];
    return true;
  }

  private async respond(ctx: ProxyContext, plan: RoutePlan, outcome: Outcome): Promise<void> {
    const { result, fallbackUsed, fallbackReason } = outcome;
    const status = result.kind === "network-error" ? 502 : result.response?.status || 502;
    const auditPromise = this.appendAuditEntry(
      ctx,
      result.backend,
      status,
      fallbackUsed,
      fallbackReason || plan.needsCloud.reason || "",
      plan.upstreamAttempted,
    ).catch(() => undefined);
    try {
      await this.sendProxyResponse(ctx.reply, result, { fallbackUsed, fallbackReason });
    } finally {
      await auditPromise;
    }
  }

  private async appendAuditEntry(
    ctx: ProxyContext,
    backendUsed: string,
    statusCode: number,
    fallbackUsed = false,
    fallbackReason = "",
    // Early rejections (`rejectEarly`) never reached an upstream; `respond` passes the real value.
    reachedBackend = false,
  ): Promise<void> {
    const entry: AuditEntry = {
      id: cryptoRandomId(),
      created_at: nowIso(),
      method: ctx.request.method,
      path: ctx.path,
      route_mode: ctx.routeMode,
      backend_used: backendUsed,
      fallback_used: fallbackUsed,
      fallback_reason: fallbackReason,
      status_code: statusCode,
      duration_ms: Date.now() - ctx.started,
      target_url: ctx.primaryTargetUrl,
      request_id: ctx.request.requestId,
      api_key_id: ctx.apiKeyId ?? undefined,
    };
    // Every audited request, including early rejections, is also counted here.
    this.metrics.observeRequest({
      backend: backendUsed,
      statusCode,
      durationMs: entry.duration_ms,
      fallbackUsed,
      reachedBackend,
      path: ctx.path,
    });
    await this.audit.appendAudit(entry);
  }

  /** Audits and answers a request that never reached an upstream. */
  private async rejectEarly(
    ctx: ProxyContext,
    backendUsed: string,
    statusCode: number,
    reason: string,
    payload: unknown,
  ): Promise<void> {
    await this.appendAuditEntry(ctx, backendUsed, statusCode, false, reason).catch(() => undefined);
    ctx.reply.code(statusCode).send(payload);
  }

  /** Reserves a Cloud key and proxies to Cloud with it; null when none is reservable. */
  private async proxyCloud(ctx: ProxyContext, plan: RoutePlan): Promise<CloudAttempt | null> {
    const reservation = await this.credits.reserve(
      plan.cloudApiKeys,
      plan.estimatedCredits,
      plan.attemptedCloudKeyIds,
    );
    if (!reservation) return null;
    plan.attemptedCloudKeyIds.add(reservation.keyId);
    plan.upstreamAttempted = true;
    const cloudResult = await this.proxyToBackend(
      "cloud",
      ctx.request,
      plan.bodyBuffer,
      this.backendUrl("cloud", ctx.upstreamUrl),
      reservation.key,
    );
    if (cloudResult.kind === "response" && cloudResult.response) {
      const status = cloudResult.response.status;
      const jsonResponse = isJsonContentType(cloudResult.response.headers.get("content-type"));
      if (cloudResult.stream && cloudResult.response.ok && jsonResponse) {
        cloudResult.stream = observeCreditsUsedStream(cloudResult.stream, (creditsUsed) =>
          this.credits.recordResponse(reservation, status, creditsUsed),
        );
      } else if (!(cloudResult.stream && !jsonResponse)) {
        const actualCreditsUsed =
          jsonResponse && cloudResult.body ? extractCreditsUsed(cloudResult.body) : null;
        if (actualCreditsUsed === null) await this.credits.recordResponse(reservation, status);
        else await this.credits.recordResponse(reservation, status, actualCreditsUsed);
      }
    }
    return { result: cloudResult, reservation };
  }

  private proxySelfHosted(ctx: ProxyContext, plan: RoutePlan): Promise<ProxyResult> {
    plan.selfHostedAttempted = true;
    // While the circuit is open the call never reaches upstream and surfaces as
    // a network error, so the existing fallback policy (and its privacy gates)
    // decides what happens next exactly as for a real connection failure.
    return this.selfHostedBreaker.execute(
      () => {
        plan.upstreamAttempted = true;
        return this.proxyToBackend(
          "self-hosted",
          ctx.request,
          plan.bodyBuffer,
          this.backendUrl("self-hosted", ctx.upstreamUrl),
        );
      },
      isSelfHostedUnavailable,
      circuitOpenResult,
    );
  }

  private getBodyBuffer(request: RequestWithContext): Buffer {
    if (Buffer.isBuffer(request.rawBody)) return request.rawBody;
    if (typeof request.rawBody === "string") return Buffer.from(request.rawBody);
    if (request.body === undefined || request.body === null) return Buffer.alloc(0);
    return Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
  }

  private privacyHeaders(request: RequestWithContext) {
    if (!this.config.authEnabled) return request.headers;
    // The gateway's own credentials are not client data: the Bearer key and, for
    // the playground, the admin session cookie must not restrict fallback.
    return Object.fromEntries(
      Object.entries(request.headers).filter(([key]) => {
        const lower = key.toLowerCase();
        return lower !== "authorization" && !(request.admin && lower === "cookie");
      }),
    );
  }

  private backendUrl(backend: Backend, path: string): string {
    const base = backend === "cloud" ? this.config.cloudBaseUrl : this.config.selfHostedBaseUrl;
    return `${base}${path}`;
  }

  private sanitizeHeaders(
    headers: RequestWithContext["headers"],
    backend: Backend,
    apiKey?: string,
  ): Record<string, string> {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      // Never forward cookies: the admin session cookie must not reach any upstream.
      if (hopByHopHeaders.has(lower) || lower === "x-firecrawl-route-mode" || lower === "cookie")
        continue;
      if (lower === "authorization" && backend !== "cloud" && this.config.authEnabled) continue;
      if (value !== undefined) next[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    if (backend === "cloud" && apiKey) next.authorization = `Bearer ${apiKey}`;
    return next;
  }

  private async proxyToBackend(
    backend: Backend,
    request: RequestWithContext,
    bodyBuffer: Buffer,
    targetUrl: string,
    apiKey?: string,
  ): Promise<ProxyResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const started = Date.now();
    let streaming = false;
    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: this.sanitizeHeaders(request.headers, backend, apiKey),
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : (bodyBuffer as unknown as BodyInit),
        redirect: "manual",
        signal: controller.signal,
      });
      if ((response.ok || response.status < 400) && response.body) {
        streaming = true;
        return {
          kind: "response",
          backend,
          response,
          stream: response.body,
          cleanup: () => clearTimeout(timeout),
          durationMs: Date.now() - started,
        };
      }
      return {
        kind: "response",
        backend,
        response,
        body: Buffer.from(await response.arrayBuffer()),
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
      if (!streaming) clearTimeout(timeout);
    }
  }

  private async sendProxyResponse(
    reply: FastifyReply,
    result: ProxyResult,
    meta: { fallbackUsed: boolean; fallbackReason: string },
  ): Promise<void> {
    if (result.kind === "network-error") {
      reply.code(502).headers({
        "content-type": "application/json; charset=utf-8",
        "x-hybrid-firecrawl-backend": result.backend,
        "x-hybrid-firecrawl-fallback": String(meta.fallbackUsed),
        "x-hybrid-firecrawl-fallback-reason": meta.fallbackReason,
      });
      reply.send(result.body);
      return;
    }
    const headers: Record<string, string> = {};
    result.response?.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      // fetch has already decoded the body, buffered or streamed, so the upstream
      // content-encoding would mislabel the bytes sent to the client.
      if (hopByHopHeaders.has(lower) || lower === "content-encoding") return;
      headers[key] = value;
    });
    headers["x-hybrid-firecrawl-backend"] = result.backend;
    headers["x-hybrid-firecrawl-fallback"] = String(meta.fallbackUsed);
    if (meta.fallbackReason) headers["x-hybrid-firecrawl-fallback-reason"] = meta.fallbackReason;
    if (!result.stream && result.body) headers["content-length"] = String(result.body.length);
    const stream = result.stream;
    if (stream) {
      reply.hijack();
      reply.raw.writeHead(result.response?.status || 502, headers);
      try {
        await new Promise<void>((resolve, reject) =>
          Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0])
            .once("error", reject)
            .once("end", resolve)
            .pipe(reply.raw)
            .once("close", resolve)
            .once("error", reject),
        );
      } finally {
        result.cleanup?.();
      }
      return;
    }
    reply
      .code(result.response?.status || 502)
      .headers(headers)
      .send(result.body);
  }

  private async getCloudKeyEntries(record: SettingRecord | null): Promise<CloudKeyEntry[]> {
    if (!record?.value) return [];
    // Keyed on the stored (encrypted) value, so a settings change is picked up on the next read.
    if (this.cloudKeysCache?.value === record.value) return [...this.cloudKeysCache.entries];
    try {
      const entries = await loadCloudKeyEntries(
        record,
        this.config.firecrawlKeysEncryptionKey,
        this.settings,
      );
      this.cloudKeysCache = { value: record.value, entries };
      this.lastCloudKeysFailure = null;
      return [...entries];
    } catch (error) {
      // Warn once per stored value rather than per request, and only with the error
      // class: a JSON parse message can quote the key material.
      if (this.lastCloudKeysFailure !== record.value) {
        this.lastCloudKeysFailure = record.value;
        this.logger.warn(
          `Could not load the Firecrawl Cloud API keys (${(error as Error).name}); ` +
            "check FIRECRAWL_KEYS_ENCRYPTION_KEY and the stored firecrawl_api_keys setting",
        );
      }
      return [];
    }
  }
}
