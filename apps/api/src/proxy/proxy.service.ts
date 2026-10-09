import { Inject, Injectable } from "@nestjs/common";
import { Readable } from "node:stream";
import type { FastifyReply } from "fastify";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import type { AuditEntry, ProxyResult, RequestWithContext } from "../common/types";
import {
  cryptoRandomId,
  collectTargetUrls,
  hasPrivateTargetUrl,
  inspectBody,
  nowIso,
} from "../common/utils";
import { decryptSettingValue, encryptSettingValue } from "../common/crypto";
import {
  chooseInitialBackend,
  getRouteMode,
  hasSensitiveHeaders,
  isCloudQuotaFallbackAllowed,
  isFallbackAllowed,
  isFallbackEligible,
  requestNeedsCloud,
} from "./policy";
import {
  SettingsService,
  parseRouteMode,
  type RouteMode,
  type SettingRecord,
} from "../settings/settings.service";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { AuditService } from "../audit/audit.service";
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

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

@Injectable()
export class ProxyService {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly settings: SettingsService,
    private readonly keys: ApiKeysService,
    private readonly audit: AuditService,
    private readonly credits: CreditRoutingService,
  ) {}

  async handle(
    request: RequestWithContext,
    reply: FastifyReply,
    originalUrl = request.raw.url || request.url,
  ): Promise<void> {
    const started = Date.now();
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(originalUrl, "http://gateway.local");
    } catch {
      reply.code(400).send({ success: false, error: "Invalid request URL" });
      return;
    }
    let primaryTargetUrl = "";
    let routeMode: string = this.configDefaultRouteMode();
    const appendAuditEntry = async (
      backendUsed: string,
      statusCode: number,
      fallbackUsed = false,
      fallbackReason = "",
    ) => {
      const entry: AuditEntry = {
        id: cryptoRandomId(),
        created_at: nowIso(),
        method: request.method,
        path: parsedUrl.pathname,
        route_mode: routeMode,
        backend_used: backendUsed,
        fallback_used: fallbackUsed,
        fallback_reason: fallbackReason,
        status_code: statusCode,
        duration_ms: Date.now() - started,
        target_url: primaryTargetUrl,
        request_id: request.requestId,
      };
      await this.audit.appendAudit(entry);
    };
    const sendEarlyResponse = async (
      backendUsed: string,
      statusCode: number,
      fallbackUsed: boolean,
      fallbackReason: string,
      payload: unknown,
    ) => {
      await appendAuditEntry(backendUsed, statusCode, fallbackUsed, fallbackReason).catch(
        () => undefined,
      );
      reply.code(statusCode).send(payload);
    };

    // Settings and API-key validation are independent, so fetch them together.
    const needsAuth = this.config.authEnabled && !request.admin;
    const bearerMatch = needsAuth
      ? String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/i)
      : null;
    const [settingRecords, authenticated] = await Promise.all([
      this.settings.getSettings(PROXY_SETTING_KEYS),
      bearerMatch ? this.keys.validateApiKey(bearerMatch[1]) : null,
    ]);
    routeMode = getRouteMode(
      originalUrl,
      request.headers,
      parseRouteMode(settingRecords.default_route_mode, this.configDefaultRouteMode()),
    );

    if (needsAuth) {
      if (!bearerMatch) {
        await sendEarlyResponse("none", 401, false, "Missing or invalid API key", {
          success: false,
          error: "Missing or invalid API key",
        });
        return;
      }
      if (!authenticated) {
        await sendEarlyResponse("none", 401, false, "Invalid or revoked API key", {
          success: false,
          error: "Invalid or revoked API key",
        });
        return;
      }
      void this.keys.touchApiKey(authenticated.id).catch(() => undefined);
    }

    const bodyBuffer = this.getBodyBuffer(request);
    if (bodyBuffer.length > this.config.maxBodyBytes) {
      await sendEarlyResponse(
        "none",
        413,
        false,
        "Request body is too large for gateway inspection",
        { success: false, error: "Request body is too large for gateway inspection" },
      );
      return;
    }
    const { json, parseError } = inspectBody(request.body, request.headers);
    if (parseError) {
      await sendEarlyResponse("none", 400, false, parseError, {
        success: false,
        error: "Invalid JSON body",
        details: parseError,
      });
      return;
    }
    const targetUrls = collectTargetUrls(json);
    primaryTargetUrl = targetUrls[0] || "";
    const privacy = {
      hasSensitiveHeaders: hasSensitiveHeaders(this.privacyHeaders(request), json),
      hasPrivateTargetUrl: hasPrivateTargetUrl(targetUrls),
    };
    const needsCloud = requestNeedsCloud(parsedUrl.pathname, json);
    const initialBackend = chooseInitialBackend(routeMode, needsCloud);
    let cloudApiKeys: string[] = [];
    if (
      initialBackend === "cloud" ||
      (initialBackend === "self-hosted" &&
        routeMode !== "self-hosted-only" &&
        isFallbackAllowed(routeMode, privacy))
    )
      cloudApiKeys = await this.getCloudApiKeys(settingRecords.firecrawl_api_keys);
    if (initialBackend === "cloud" && !cloudApiKeys.length) {
      await sendEarlyResponse("none", 502, false, "No Firecrawl Cloud API key configured", {
        success: false,
        error: "No Firecrawl Cloud API key configured. Add one in Settings.",
      });
      return;
    }
    if (initialBackend === "reject") {
      await sendEarlyResponse("none", 409, false, needsCloud.reason, {
        success: false,
        error: "This request requires Firecrawl Cloud, but route mode is self-hosted-only.",
        reason: needsCloud.reason,
      });
      return;
    }

    const estimatedCredits = estimateCreditCost(parsedUrl.pathname, json);
    const attemptedCloudKeyIds = new Set<string>();
    const proxyCloud = async (): Promise<{
      result: ProxyResult;
      reservation: CreditReservation;
    } | null> => {
      const reservation = await this.credits.reserve(
        cloudApiKeys,
        estimatedCredits,
        attemptedCloudKeyIds,
      );
      if (!reservation) return null;
      attemptedCloudKeyIds.add(reservation.keyId);
      const cloudResult = await this.proxyToBackend(
        "cloud",
        request,
        bodyBuffer,
        this.backendUrl("cloud", originalUrl),
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
    };

    let fallbackUsed = false;
    let fallbackReason = "";
    let cloudAttempt: { result: ProxyResult; reservation: CreditReservation } | null = null;
    let result: ProxyResult;
    if (initialBackend === "cloud") {
      cloudAttempt = await proxyCloud();
      if (!cloudAttempt) {
        if (isCloudQuotaFallbackAllowed(routeMode, needsCloud)) {
          fallbackUsed = true;
          fallbackReason = "No available Firecrawl Cloud credit pool; falling back to self-hosted";
          result = await this.proxyToBackend(
            "self-hosted",
            request,
            bodyBuffer,
            this.backendUrl("self-hosted", originalUrl),
          );
        } else {
          await sendEarlyResponse("cloud", 429, false, "No available Firecrawl Cloud credit pool", {
            success: false,
            error:
              "No available Firecrawl Cloud credit pool. Refresh credit usage or try again later.",
          });
          return;
        }
      } else {
        result = cloudAttempt.result;
      }
    } else {
      result = await this.proxyToBackend(
        initialBackend,
        request,
        bodyBuffer,
        this.backendUrl(initialBackend, originalUrl),
      );
      if (
        initialBackend === "self-hosted" &&
        cloudApiKeys.length > 0 &&
        isFallbackEligible(result) &&
        isFallbackAllowed(routeMode, privacy)
      ) {
        cloudAttempt = await proxyCloud();
        if (cloudAttempt) {
          fallbackUsed = true;
          fallbackReason =
            result.kind === "network-error"
              ? result.error?.message || "self-hosted network error"
              : `self-hosted returned ${result.response?.status}`;
          result = cloudAttempt.result;
        }
      }
    }

    let allCloudKeysQuotaLimited = false;
    if (
      cloudAttempt &&
      result.backend === "cloud" &&
      result.kind === "response" &&
      result.response &&
      RETRYABLE_CLOUD_STATUS.has(result.response.status)
    ) {
      const firstStatus = result.response.status;
      let attempts = 1;
      let quotaAttempts = CLOUD_CAPACITY_STATUS.has(firstStatus) ? 1 : 0;
      while (true) {
        const next = await proxyCloud();
        if (!next) break;
        attempts++;
        if (
          next.result.kind === "response" &&
          next.result.response &&
          CLOUD_CAPACITY_STATUS.has(next.result.response.status)
        )
          quotaAttempts++;
        if (
          next.result.kind === "response" &&
          next.result.response &&
          !RETRYABLE_CLOUD_STATUS.has(next.result.response.status)
        ) {
          fallbackUsed = true;
          fallbackReason = `primary cloud key failed with ${firstStatus}, next key succeeded`;
          result = next.result;
          cloudAttempt = next;
          break;
        }
        result = next.result;
        cloudAttempt = next;
      }
      allCloudKeysQuotaLimited = quotaAttempts === attempts;
    }
    if (
      allCloudKeysQuotaLimited &&
      result.backend === "cloud" &&
      result.kind === "response" &&
      result.response &&
      CLOUD_CAPACITY_STATUS.has(result.response.status) &&
      isCloudQuotaFallbackAllowed(routeMode, needsCloud)
    ) {
      fallbackUsed = true;
      fallbackReason = `all ${cloudApiKeys.length} cloud API key(s) are unavailable (${result.response.status}); falling back to self-hosted`;
      result = await this.proxyToBackend(
        "self-hosted",
        request,
        bodyBuffer,
        this.backendUrl("self-hosted", originalUrl),
      );
    }
    const status = result.kind === "network-error" ? 502 : result.response?.status || 502;
    const auditPromise = appendAuditEntry(
      result.backend,
      status,
      fallbackUsed,
      fallbackReason || needsCloud.reason || "",
    ).catch(() => undefined);
    try {
      await this.sendProxyResponse(reply, result, { fallbackUsed, fallbackReason });
    } finally {
      await auditPromise;
    }
  }

  private configDefaultRouteMode(): RouteMode {
    return "cloud-first";
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
    return Object.fromEntries(
      Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== "authorization"),
    );
  }

  private backendUrl(backend: string, originalUrl: string): string {
    const base = backend === "cloud" ? this.config.cloudBaseUrl : this.config.selfHostedBaseUrl;
    return `${base}${originalUrl}`;
  }

  private sanitizeHeaders(
    headers: RequestWithContext["headers"],
    backend: string,
    apiKey?: string,
  ): Record<string, string> {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (hopByHopHeaders.has(lower) || lower === "x-firecrawl-route-mode") continue;
      if (lower === "authorization" && backend !== "cloud" && this.config.authEnabled) continue;
      if (value !== undefined) next[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    if (backend === "cloud" && apiKey) next.authorization = `Bearer ${apiKey}`;
    return next;
  }

  private async proxyToBackend(
    backend: string,
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
      if (hopByHopHeaders.has(lower) || (!result.stream && lower === "content-encoding")) return;
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

  private async getCloudApiKeys(record: SettingRecord | null): Promise<string[]> {
    try {
      if (!record?.value) return [];
      const decrypted = decryptSettingValue(record.value, this.config.firecrawlKeysEncryptionKey);
      if (!decrypted.encrypted)
        // Conditional: `record` may predate a concurrent admin update that must not be overwritten.
        await this.settings.replaceSettingIfUnchanged(
          record.key,
          record.value,
          encryptSettingValue(record.value, this.config.firecrawlKeysEncryptionKey),
        );
      const parsed = JSON.parse(decrypted.value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((key): key is string => typeof key === "string" && key.length > 0)
        : [];
    } catch {
      return [];
    }
  }
}
