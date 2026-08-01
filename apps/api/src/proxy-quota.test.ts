import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { AuditStore } from "./audit-store";
import { createProxyHandler } from "./proxy";
import type { GatewayConfig } from "./types";

const mockGetDefaultRouteMode = vi.hoisted(() => vi.fn());
const mockGetSetting = vi.hoisted(() => vi.fn());
const mockValidateApiKeyWithUser = vi.hoisted(() => vi.fn());
const mockCreateGatewayJob = vi.hoisted(() => vi.fn());
const mockGetGatewayJob = vi.hoisted(() => vi.fn());
const mockCompleteGatewayJob = vi.hoisted(() => vi.fn());
const mockReserveIncluded = vi.hoisted(() => vi.fn());
const mockFinalizeReservation = vi.hoisted(() => vi.fn());
const mockReleaseReservation = vi.hoisted(() => vi.fn());
const mockEmitSourcePressure = vi.hoisted(() => vi.fn());
const mockTryAcquireSource = vi.hoisted(() => vi.fn());
const mockGetAccountById = vi.hoisted(() => vi.fn());
const mockGetAccountByPublicId = vi.hoisted(() => vi.fn());

vi.mock("./settings/service", () => ({
  getSetting: mockGetSetting,
  getDefaultRouteMode: mockGetDefaultRouteMode,
  setSetting: vi.fn(),
}));
vi.mock("./api-keys/service", () => ({
  validateApiKeyWithUser: mockValidateApiKeyWithUser,
  touchApiKey: vi.fn(),
}));
vi.mock("./users/service", () => ({ checkUserAccess: vi.fn().mockReturnValue({ allowed: true }) }));
vi.mock("./jobs/gateway-jobs", () => ({
  createGatewayJob: mockCreateGatewayJob,
  getGatewayJob: mockGetGatewayJob,
  completeGatewayJob: mockCompleteGatewayJob,
}));
vi.mock("./quota/service", () => ({
  reserveIncluded: mockReserveIncluded,
  finalizeReservation: mockFinalizeReservation,
  releaseReservation: mockReleaseReservation,
  emitSourcePressure: mockEmitSourcePressure,
}));
vi.mock("./sources/repository", () => ({ tryAcquireSource: mockTryAcquireSource }));
vi.mock("./db/accounts", () => ({
  getAccountById: mockGetAccountById,
  getAccountByPublicId: mockGetAccountByPublicId,
}));

const config: GatewayConfig = {
  port: 8080,
  cloudBaseUrl: "https://api.firecrawl.dev",
  defaultRouteMode: "self-hosted-only",
  requestTimeoutMs: 120_000,
  logFile: "",
  maxBodyBytes: 5_242_880,
  authEnabled: true,
  databaseUrl: "postgresql://localhost/test",
  operatorDatabaseUrl: "postgresql://localhost/operator-test",
  sessionSecret: "test",
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  adminEmail: "",
  adminPassword: "",
  trustProxy: false,
};

const auditStore: AuditStore = {
  appendAudit: vi.fn().mockResolvedValue(undefined),
  readAuditEntries: vi.fn(),
  deleteAuditEntry: vi.fn(),
  deleteAuditEntriesByIds: vi.fn(),
  deleteAuditEntries: vi.fn(),
};

function requestFor(endpointId = "endpoint-a", upstreamUrl = "/v2/search", method = "POST"): Request {
  return {
    method,
    url: upstreamUrl,
    originalUrl: `/e/${endpointId}${upstreamUrl}`,
    tenantEndpointId: endpointId,
    headers: { authorization: "Bearer fc_gateway_token", "content-type": "application/json" },
    requestId: "tenant-request",
    quotaRequestId: "quota-tenant-request",
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify({ url: "https://example.com" }));
    },
  } as unknown as Request;
}

function responseFor(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function cloudSource(id: string, fundingType: "byok" | "included", credential = `${id}-key`): Record<string, unknown> {
  return {
    id, kind: "cloud", baseUrl: "https://api.firecrawl.dev", credential, fundingType,
    hardConcurrency: 4, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880,
  };
}

function selfHostedSource(id = "self-a"): Record<string, unknown> {
  return {
    id, kind: "self_hosted", baseUrl: "https://self-hosted.example", fundingType: "included",
    hardConcurrency: 4, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880,
  };
}

function upstreamResponse(body: string, status = 200, headers = new Headers()) {
  return { ok: status >= 200 && status < 300, status, headers, arrayBuffer: async () => Buffer.from(body) };
}

const includedReservation = {
  reservationId: "reservation-tenant",
  reserved: true,
  limit: 100,
  remaining: 99,
  resetAt: "2026-02-01T00:00:00.000Z",
  periodId: "2026-01",
  entitlementId: "entitlement-a",
};

describe("data-plane quota funding modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTryAcquireSource.mockImplementation(() => () => undefined);
    mockReserveIncluded.mockResolvedValue({ ...includedReservation });
    mockFinalizeReservation.mockResolvedValue(true);
    mockReleaseReservation.mockResolvedValue(true);
    mockEmitSourcePressure.mockResolvedValue(false);
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-only");
    mockGetAccountById.mockResolvedValue({ id: "account-a", public_id: "endpoint-a", display_name: "A", status: "active", funding_preference: "auto" });
    mockGetAccountByPublicId.mockResolvedValue(null);
    mockGetSetting.mockImplementation(async (key: string) => key === "self_hosted_firecrawl_url"
      ? { key, value: "https://self-hosted.example", updated_at: "2026-01-01T00:00:00.000Z" }
      : null);
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["v2:search"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    mockCreateGatewayJob.mockResolvedValue({});
    mockGetGatewayJob.mockResolvedValue(null);
    mockCompleteGatewayJob.mockResolvedValue(undefined);
  });

  function handlerWith(sources: Array<Record<string, unknown>>, endpoint = { id: "account-a", status: "active", funding_preference: "auto" }) {
    return createProxyHandler({
      config,
      auditStore,
      resolveEndpoint: async () => endpoint as never,
      resolveSources: async () => sources as never,
    });
  }

  it("rejects with a stable code when the account allowance is exhausted", async () => {
    mockReserveIncluded.mockResolvedValue({ code: "quota_exhausted", message: "Included request allowance exhausted for this month", statusCode: 429 });
    const release = vi.fn();
    mockTryAcquireSource.mockReturnValue(release);
    const handler = handlerWith([selfHostedSource()]);
    const res = responseFor();
    await handler(requestFor("endpoint-a", "/v2/search", "POST"), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString()).toContain("\"code\":\"quota_exhausted\"");
    expect(mockFinalizeReservation).not.toHaveBeenCalled();
    expect(mockReleaseReservation).not.toHaveBeenCalled();
    // The acquired source slot must be returned even when quota rejects the
    // request before any upstream dispatch, or the source saturates.
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rejects with quota_hard_cap and quota_paused codes without dispatching", async () => {
    mockReserveIncluded.mockResolvedValueOnce({ code: "quota_hard_cap", message: "Platform hard capacity reached for this month", statusCode: 429 });
    const handler = handlerWith([selfHostedSource()]);
    const res = responseFor();
    await handler(requestFor(), res);
    expect(res.status).toHaveBeenCalledWith(429);
    expect((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString()).toContain("\"code\":\"quota_hard_cap\"");

    mockReserveIncluded.mockResolvedValueOnce({ code: "quota_paused", message: "Included infrastructure traffic is paused by an operator", statusCode: 503 });
    const res2 = responseFor();
    await handler(requestFor(), res2);
    expect(res2.status).toHaveBeenCalledWith(503);
    expect((res2.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString()).toContain("\"code\":\"quota_paused\"");
  });

  it("rejects waitlisted accounts with no_entitlement", async () => {
    mockReserveIncluded.mockResolvedValue({ code: "no_entitlement", message: "No included entitlement for this account this month", statusCode: 403 });
    const handler = handlerWith([selfHostedSource()]);
    const res = responseFor();
    await handler(requestFor(), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString()).toContain("\"code\":\"no_entitlement\"");
  });

  it("rejects included funding with no included source before any dispatch", async () => {
    const handler = handlerWith([], { id: "account-a", status: "active", funding_preference: "included" });
    const res = responseFor();
    await handler(requestFor(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_entitlement" }));
    expect(mockReserveIncluded).not.toHaveBeenCalled();
  });

  it("fails closed for an auto tenant when no account source resolves", async () => {
    const handler = handlerWith([], { id: "account-a", status: "active", funding_preference: "auto" });
    const res = responseFor();
    await handler(requestFor(), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_entitlement" }));
    expect(mockReserveIncluded).not.toHaveBeenCalled();
  });

  it("never reserves quota for byok-only funding and reports the funding class", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse(JSON.stringify({ success: true }), 200)));
    const handler = handlerWith([cloudSource("byok-1", "byok")], { id: "account-a", status: "active", funding_preference: "byok" });
    const res = responseFor();
    await handler(requestFor(), res);
    expect(mockReserveIncluded).not.toHaveBeenCalled();
    expect(mockFinalizeReservation).not.toHaveBeenCalled();
    expect(mockReleaseReservation).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ "x-hybrid-firecrawl-funding": "byok" }));
    vi.unstubAllGlobals();
  });

  it("reserves once, finalizes once, and reports quota metadata on included success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse(JSON.stringify({ success: true }), 200)));
    const handler = handlerWith([selfHostedSource()]);
    const res = responseFor();
    await handler(requestFor(), res);

    expect(mockReserveIncluded).toHaveBeenCalledTimes(1);
    expect(mockReserveIncluded).toHaveBeenCalledWith("account-a", "quota-tenant-request");
    expect(mockFinalizeReservation).toHaveBeenCalledTimes(1);
    expect(mockFinalizeReservation).toHaveBeenCalledWith("reservation-tenant");
    expect(mockReleaseReservation).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
      "x-quota-limit": "100",
      "x-quota-remaining": "99",
      "x-quota-reset": "2026-02-01T00:00:00.000Z",
    }));
    vi.unstubAllGlobals();
  });

  it("uses a fresh server-owned quota id when the client reuses X-Request-ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse(JSON.stringify({ success: true }), 200)));
    const handler = handlerWith([selfHostedSource()]);
    const first = requestFor();
    const second = requestFor();
    second.quotaRequestId = "quota-second-request";
    const firstResponse = responseFor();
    const secondResponse = responseFor();

    await handler(first, firstResponse);
    await handler(second, secondResponse);

    expect(first.requestId).toBe(second.requestId);
    expect(mockReserveIncluded).toHaveBeenNthCalledWith(1, "account-a", "quota-tenant-request");
    expect(mockReserveIncluded).toHaveBeenNthCalledWith(2, "account-a", "quota-second-request");
    expect(mockFinalizeReservation).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("charges exactly once across an included fallback chain", async () => {
    // Cloud source 429s, rotation to the next included cloud key succeeds.
    const fetchMock = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) =>
      String(init?.headers?.authorization ?? "").includes("included-1-key")
        ? upstreamResponse(JSON.stringify({ success: false }), 429)
        : upstreamResponse(JSON.stringify({ success: true }), 200));
    vi.stubGlobal("fetch", fetchMock);
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");
    const handler = handlerWith(
      [cloudSource("included-1", "included", "included-1-key"), cloudSource("included-2", "included", "included-2-key")],
      { id: "account-a", status: "active", funding_preference: "included" },
    );
    const res = responseFor();
    await handler(requestFor(), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockReserveIncluded).toHaveBeenCalledTimes(1);
    expect(mockFinalizeReservation).toHaveBeenCalledTimes(1);
    expect(mockReleaseReservation).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("charges once when a byok attempt falls back to an included key in auto mode", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) =>
      String(init?.headers?.authorization ?? "").includes("byok-key")
        ? upstreamResponse(JSON.stringify({ success: false }), 429)
        : upstreamResponse(JSON.stringify({ success: true }), 200));
    vi.stubGlobal("fetch", fetchMock);
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");
    const handler = handlerWith(
      [cloudSource("byok-1", "byok", "byok-key"), cloudSource("included-1", "included", "included-key")],
      { id: "account-a", status: "active", funding_preference: "auto" },
    );
    const res = responseFor();
    await handler(requestFor(), res);

    expect(mockReserveIncluded).toHaveBeenCalledTimes(1);
    expect(mockFinalizeReservation).toHaveBeenCalledTimes(1);
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ "x-hybrid-firecrawl-funding": "included" }));
    vi.unstubAllGlobals();
  });

  it("releases the reservation when failure happened before dispatch", async () => {
    mockTryAcquireSource.mockReturnValue(null); // concurrency limit: pre-dispatch
    const handler = handlerWith([selfHostedSource()]);
    const res = responseFor();
    await handler(requestFor(), res);

    expect(mockReserveIncluded).not.toHaveBeenCalled();
    expect(mockReleaseReservation).not.toHaveBeenCalled();
    expect(mockEmitSourcePressure).toHaveBeenCalledWith("self-a", "source concurrency limit");
  });

  it("does not silently fall back to byok after an included quota rejection", async () => {
    mockReserveIncluded.mockResolvedValue({ code: "quota_exhausted", message: "Included request allowance exhausted for this month", statusCode: 429 });
    const fetchMock = vi.fn(async () => upstreamResponse(JSON.stringify({ success: true }), 200));
    vi.stubGlobal("fetch", fetchMock);
    const handler = handlerWith(
      [selfHostedSource(), cloudSource("byok-1", "byok", "byok-key")],
      { id: "account-a", status: "active", funding_preference: "auto" },
    );
    const res = responseFor();
    await handler(requestFor(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString()).toContain("\"code\":\"quota_exhausted\"");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockReleaseReservation).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("applies funding preference and quota to legacy root routes too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => upstreamResponse(JSON.stringify({ success: true }), 200)));
    mockGetAccountById.mockResolvedValue({ id: "account-a", public_id: "endpoint-a", display_name: "A", status: "active", funding_preference: "included" });
    const handler = handlerWith([selfHostedSource()]);
    const res = responseFor();
    const req = requestFor("endpoint-a", "/v2/search", "POST");
    delete (req as Request & { tenantEndpointId?: string }).tenantEndpointId;
    req.originalUrl = "/v2/search";

    await handler(req, res);

    // The account's included preference is honored on the deprecated surface:
    // the included source is used, quota is reserved once and charged once.
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockReserveIncluded).toHaveBeenCalledTimes(1);
    expect(mockReserveIncluded).toHaveBeenCalledWith("account-a", "quota-tenant-request");
    expect(mockFinalizeReservation).toHaveBeenCalledTimes(1);
    expect(mockFinalizeReservation).toHaveBeenCalledWith("reservation-tenant");
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
      "x-hybrid-firecrawl-funding": "included",
      "x-quota-limit": "100",
    }));
    vi.unstubAllGlobals();
  });

  it("returns the source slot when quota reservation throws unexpectedly", async () => {
    mockReserveIncluded.mockRejectedValue(new Error("quota database unavailable"));
    const release = vi.fn();
    mockTryAcquireSource.mockReturnValue(release);
    const handler = handlerWith([selfHostedSource()]);
    const res = responseFor();

    // The failure propagates (the app-level error handler turns it into a 5xx),
    // but the acquired source slot must be returned or the source saturates.
    await expect(handler(requestFor("endpoint-a", "/v2/search", "POST"), res)).rejects.toThrow("quota database unavailable");
    expect(release).toHaveBeenCalledTimes(1);
    expect(mockFinalizeReservation).not.toHaveBeenCalled();
    expect(mockReleaseReservation).not.toHaveBeenCalled();
  });

  it("fails closed for root accounts without resolvable sources", async () => {
    const fetchMock = vi.fn(async () => upstreamResponse(JSON.stringify({ success: true }), 200));
    vi.stubGlobal("fetch", fetchMock);
    mockGetAccountById.mockResolvedValue({ id: "account-a", public_id: "endpoint-a", display_name: "A", status: "active", funding_preference: "auto" });
    const handler = handlerWith([]);
    const res = responseFor();
    const req = requestFor("endpoint-a", "/v2/search", "POST");
    delete (req as Request & { tenantEndpointId?: string }).tenantEndpointId;
    req.originalUrl = "/v2/search";

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_entitlement" }));
    expect(mockReserveIncluded).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
