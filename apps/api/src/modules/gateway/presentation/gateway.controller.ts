import crypto from "node:crypto";
import { All, Controller, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppConfigService } from "../../../core/config/config.service";
import { GatewayTokensService } from "../../gateway-tokens/application/gateway-tokens.service";
import { InfrastructureService, type ResolvedInfrastructureSource } from "../../infrastructure/application/infrastructure.service";
import { SettingsService } from "../../settings/application/settings.service";
import { GatewayJobsService } from "../application/gateway-jobs.service";
import { classifyAsyncRoute, replaceAsyncRouteId } from "../application/gateway-routes";
import { virtualizeCreationResponse } from "../application/gateway-virtualization";
import { GatewayAuditService } from "../application/gateway-audit.service";
import { chooseInitialBackend, getRouteMode, hasPrivateTargetUrl, isFallbackAllowed, requestNeedsCloud, tokenScopeAllowsPath, validateGatewayRequest } from "../application/gateway-policy";
import { GatewayResponseService } from "../application/gateway-response.service";
import { GatewayTransportService, type GatewayTransportResult } from "../application/gateway-transport.service";
import { QuotaService, type QuotaReservation } from "../../quota/application/quota.service";
import { AccountsService } from "../../accounts/application/accounts.service";

type DispatchOutcome = { result: GatewayTransportResult; quota: QuotaReservation | null; includedDispatched: boolean; quotaRejected: boolean; };

function hasTerminalAsyncStatus(body: Buffer | undefined): boolean {
  if (!body || body.length > 64 * 1024) return false;
  try {
    const value = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const nested = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data as Record<string, unknown> : undefined;
    const status = typeof value.status === "string" ? value.status : nested?.status;
    return typeof status === "string" && ["completed", "failed", "cancelled"].includes(status.toLowerCase());
  } catch { return false; }
}

@Controller()
export class GatewayController {
  constructor(private readonly config: AppConfigService, private readonly tokens: GatewayTokensService, private readonly infrastructure: InfrastructureService, private readonly settings: SettingsService, private readonly jobs: GatewayJobsService, private readonly transport: GatewayTransportService, private readonly responses: GatewayResponseService, private readonly quota: QuotaService, private readonly accounts: AccountsService, private readonly audit: GatewayAuditService) {}

  @All(["v1/*", "v2/*", "e/:endpointId/v1/*", "e/:endpointId/v2/*"])
  async proxy(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const started = Date.now();
    const requestAbort = new AbortController();
    request.raw.once("aborted", () => requestAbort.abort());
    request.raw.once("close", () => { if (!request.raw.complete) requestAbort.abort(); });
    const parsed = new URL(request.raw.url ?? request.url, "http://gateway.local");
    const tenantMatch = parsed.pathname.match(/^\/e\/([^/]+)(\/v[12]\/.*)$/);
    const tenantEndpointId = tenantMatch ? decodeURIComponent(tenantMatch[1]) : null;
    const pathname = tenantMatch ? tenantMatch[2] : parsed.pathname;
    const body = request.body;
    const rejected = validateGatewayRequest(pathname, body);
    if (rejected) { this.error(reply, rejected.statusCode, rejected.reason); return; }

    const authentication = await this.authenticate(request, pathname, reply, tenantEndpointId !== null);
    if (!authentication) return;
    const endpoint = tenantEndpointId ? await this.accounts.findAccountByPublicId(tenantEndpointId) : null;
    if (tenantEndpointId && (!endpoint || endpoint.status !== "active" || (authentication.accountId && authentication.accountId !== endpoint.id))) { this.error(reply, 404, "Tenant endpoint unavailable"); return; }
    const accountId = endpoint?.id ?? authentication.accountId;
    const fundingPreference = endpoint?.fundingPreference === "byok" || endpoint?.fundingPreference === "included" ? endpoint.fundingPreference : "auto";
    const routing = await this.routingSettings();
    const routeMode = getRouteMode(request.url, request.headers, routing.defaultRouteMode);
    const needsCloud = requestNeedsCloud(pathname, body);
    const initialBackend = chooseInitialBackend(routeMode, needsCloud);
    if (initialBackend === "reject") { this.error(reply, 400, needsCloud.reason); return; }

    const asyncRoute = classifyAsyncRoute(request.method, pathname);
    let lifecycleJob: Awaited<ReturnType<GatewayJobsService["get"]>> = null;
    let upstreamPath = `${pathname}${parsed.search}`;
    if (asyncRoute?.kind === "lifecycle") {
      if (!accountId) { this.error(reply, 401, "Missing or invalid API key"); return; }
      lifecycleJob = await this.jobs.get(accountId, asyncRoute.publicId!);
      if (!lifecycleJob || lifecycleJob.route_family !== asyncRoute.family) { this.error(reply, 404, "Tenant async job unavailable"); return; }
      upstreamPath = `${replaceAsyncRouteId(asyncRoute, lifecycleJob.upstream_job_id)}${parsed.search}`;
    }

    let sources = await this.infrastructure.resolve(accountId ?? "", accountId ? (tenantEndpointId ? fundingPreference : "auto") : "included");
    if (lifecycleJob) {
      const pinned = sources.find((source) => source.id === lifecycleJob!.source_id && (!lifecycleJob!.credential_id || source.credentialId === lifecycleJob!.credential_id));
      if (!pinned) { this.error(reply, 503, "Recorded job source unavailable"); return; }
      sources = [pinned];
    }
    const primary = lifecycleJob ? sources[0] : this.pickSource(sources, initialBackend, routing.selfHostedUrl);
    if (!primary) { this.error(reply, 503, initialBackend === "cloud" ? "No active Cloud source available" : "No active self-hosted source available"); return; }

    const requestId = crypto.randomUUID();
    let selectedSource = primary;
    let dispatch = await this.dispatch(request, primary, upstreamPath, body, asyncRoute, accountId, requestId, requestAbort.signal);
    let result = dispatch.result;
    let fallbackUsed = false;
    let fallbackReason = "";
    if (!requestAbort.signal.aborted && !dispatch.quotaRejected && (result.kind === "network-error" || (result.response && result.response.status >= 500))) {
      const privacy = { hasSensitiveHeaders: Object.keys(request.headers).some((key) => ["authorization", "cookie"].includes(key.toLowerCase())), hasPrivateTargetUrl: hasPrivateTargetUrl(body) };
      if (isFallbackAllowed(routeMode, privacy) && initialBackend === "self-hosted" && !needsCloud.required) {
        const cloud = this.pickSource(sources, "cloud", "");
        if (cloud) {
          if (dispatch.quota) await this.quota.releaseReservation(dispatch.quota.reservationId).catch(() => undefined);
          fallbackUsed = true;
          fallbackReason = "self-hosted source failed";
          const fallback = await this.dispatch(request, cloud, upstreamPath, body, asyncRoute, accountId, requestId, requestAbort.signal);
          selectedSource = cloud;
          dispatch = fallback;
          result = fallback.result;
        }
      }
    }
    if (tenantEndpointId && accountId && asyncRoute?.kind === "create" && result.kind === "response" && result.response && result.response.status >= 200 && result.response.status < 300 && result.body) {
      const publicJobId = crypto.randomUUID();
      const publicUrl = `/e/${encodeURIComponent(tenantEndpointId)}${asyncRoute.family}/${encodeURIComponent(publicJobId)}`;
      const virtualized = virtualizeCreationResponse(result.body, publicJobId, publicUrl);
      if (!virtualized) {
        result = { kind: "network-error", backend: result.backend, body: Buffer.from(JSON.stringify({ success: false, error: "Gateway could not safely virtualize the async job response" })), error: new Error("Gateway could not safely virtualize the async job response"), statusCode: 502, durationMs: result.durationMs };
      } else {
        try {
          await this.jobs.create(accountId, { publicJobId, upstreamJobId: virtualized.upstreamJobId, routeFamily: asyncRoute.family, sourceId: selectedSource.id, credentialId: selectedSource.credentialId, fundingType: selectedSource.fundingType, creationRequest: body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {} });
          result = { ...result, body: virtualized.body };
        } catch {
          result = { kind: "network-error", backend: result.backend, body: Buffer.from(JSON.stringify({ success: false, error: "Gateway could not persist the async job response" })), error: new Error("Gateway could not persist the async job response"), statusCode: 502, durationMs: result.durationMs };
        }
      }
    }
    if (lifecycleJob && accountId && result.kind === "response" && result.response && result.response.status >= 200 && result.response.status < 300 && (request.method.toUpperCase() === "DELETE" || (request.method.toUpperCase() === "GET" && hasTerminalAsyncStatus(result.body)))) {
      await this.jobs.complete(accountId, asyncRoute!.publicId!).catch(() => undefined);
    }
    if (dispatch.quota) {
      const finalize = dispatch.includedDispatched && !requestAbort.signal.aborted ? this.quota.finalizeReservation(dispatch.quota.reservationId) : this.quota.releaseReservation(dispatch.quota.reservationId);
      await finalize.catch(() => undefined);
    }
    const statusCode = result.kind === "network-error" ? result.statusCode ?? 502 : result.response?.status ?? 502;
    await this.audit.write({ method: request.method, path: parsed.pathname, routeMode, backendUsed: result.backend, fundingType: dispatch.includedDispatched ? "included" : selectedSource.fundingType, fallbackUsed, fallbackReason, statusCode, durationMs: Date.now() - started, userId: authentication.userId, accountId, requestId }).catch(() => undefined);
    await this.responses.send(reply, result, { fallbackUsed, fallbackReason, fundingType: dispatch.includedDispatched ? "included" : selectedSource.fundingType, quota: dispatch.quota });
  }

  private async dispatch(request: FastifyRequest, source: ResolvedInfrastructureSource, path: string, body: unknown, asyncRoute: ReturnType<typeof classifyAsyncRoute>, accountId?: string, requestId?: string, requestSignal?: AbortSignal): Promise<DispatchOutcome> {
    const release = this.infrastructure.tryAcquire(source);
    if (!release) return { result: { kind: "network-error", backend: source.kind === "cloud" ? "cloud" : "self-hosted", body: Buffer.from(JSON.stringify({ success: false, error: "Selected source is at its concurrency limit" })), error: new Error("Selected source is at its concurrency limit"), statusCode: 503, durationMs: 0 }, quota: null, includedDispatched: false, quotaRejected: false };
    let quota: QuotaReservation | null = null;
    const includedDispatched = source.fundingType === "included" && Boolean(accountId);
    if (includedDispatched) {
      const reservation = await this.quota.reserveIncluded(accountId!, requestId ?? crypto.randomUUID());
      if ("code" in reservation) {
        release();
        return { result: { kind: "network-error", backend: source.kind === "cloud" ? "cloud" : "self-hosted", body: Buffer.from(JSON.stringify({ success: false, error: reservation.message, code: reservation.code })), error: new Error(reservation.message), statusCode: reservation.statusCode, durationMs: 0 }, quota: null, includedDispatched: false, quotaRejected: true };
      }
      quota = reservation;
    }
    const buffer = body === undefined || body === null ? Buffer.alloc(0) : typeof body === "string" ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
    const result = await this.transport.execute({ backend: source.kind === "cloud" ? "cloud" : "self-hosted", targetUrl: `${source.baseUrl}${path}`, method: request.method, headers: request.headers, body: buffer, apiKey: source.credential, authEnabled: this.config.authEnabled, timeoutMs: source.requestTimeoutMs, responseBufferMaxBytes: source.responseBufferMaxBytes, bufferSuccess: asyncRoute?.kind === "create", successBufferMaxBytes: asyncRoute?.kind === "lifecycle" && request.method === "GET" ? 64 * 1024 : undefined, requestSignal });
    if (source.fundingType === "byok" && accountId && source.credentialId) await this.infrastructure.touchCredential(accountId, source.credentialId).catch(() => undefined);
    if (result.stream) { const cleanup = result.cleanup; result.cleanup = () => { cleanup?.(); release(); }; } else release();
    return { result, quota, includedDispatched, quotaRejected: false };
  }

  private async authenticate(request: FastifyRequest, pathname: string, reply: FastifyReply, requireToken = false): Promise<{ accountId: string; userId: string } | null> {
    if (!this.config.authEnabled && !requireToken) return {} as { accountId: string; userId: string };
    const value = request.headers.authorization;
    const match = typeof value === "string" ? value.match(/^Bearer\s+(.+)$/i) : null;
    const token = match ? await this.tokens.authenticate(match[1]) : null;
    if (!token) { this.error(reply, 401, "Missing or invalid API key"); return null; }
    if (token.userStatus === "blocked" || (token.userStatus === "suspended" && token.suspendedUntil && new Date(token.suspendedUntil).getTime() > Date.now())) { this.error(reply, 403, token.userStatus === "blocked" ? "Account blocked" : "Account suspended"); return null; }
    if (!tokenScopeAllowsPath(token.scopes, pathname)) { this.error(reply, 403, "Gateway token scope does not allow this path"); return null; }
    return { accountId: token.accountId, userId: token.userId };
  }

  private pickSource(sources: ResolvedInfrastructureSource[], backend: string, selfHostedUrl: string): ResolvedInfrastructureSource | null {
    const kind = backend === "cloud" ? "cloud" : "self_hosted";
    const source = sources.find((candidate) => candidate.kind === kind);
    if (source) return source;
    if (kind === "self_hosted" && selfHostedUrl) return { id: "settings:self-hosted", kind: "self_hosted", baseUrl: selfHostedUrl, fundingType: "included", hardConcurrency: 1, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880 };
    return null;
  }

  private async routingSettings(): Promise<{ defaultRouteMode: string; selfHostedUrl: string }> { try { return await this.settings.routing(); } catch { return { defaultRouteMode: "cloud-first", selfHostedUrl: "" }; } }
  private error(reply: FastifyReply, status: number, message: string): void { void reply.status(status).send({ success: false, error: message }); }
}
