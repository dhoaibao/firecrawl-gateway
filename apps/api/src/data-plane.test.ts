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

function requestFor(endpointId = "endpoint-a", upstreamUrl = "/v2/scrape?formats=markdown", method = "POST"): Request {
  return {
    method,
    url: upstreamUrl,
    originalUrl: `/e/${endpointId}${upstreamUrl}`,
    tenantEndpointId: endpointId,
    headers: { authorization: "Bearer fc_gateway_token", "content-type": "application/json" },
    requestId: "tenant-request",
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

function selfHostedSource() {
  return {
    id: "self-a", kind: "self_hosted" as const, baseUrl: "https://self-hosted.example", fundingType: "included" as const,
    hardConcurrency: 1, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880,
  };
}

function gatewayJob(routeFamily: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "job-row", account_id: "account-a", public_job_id: "public-job", upstream_job_id: "upstream/job",
    route_family: routeFamily, source_id: "self-a", credential_id: null, funding_type: "included",
    creation_request: {}, created_at: "2026-01-01", updated_at: "2026-01-01", completed_at: null,
    ...overrides,
  };
}

function upstreamResponse(body: string, status = 200, headers = new Headers()) {
  return { ok: status >= 200 && status < 300, status, headers, arrayBuffer: async () => Buffer.from(body) };
}

describe("tenant data-plane routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateGatewayJob.mockResolvedValue({});
    mockGetGatewayJob.mockResolvedValue(null);
    mockCompleteGatewayJob.mockResolvedValue(undefined);
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-only");
    mockGetSetting.mockImplementation(async (key: string) => key === "self_hosted_firecrawl_url"
      ? { key, value: "https://self-hosted.example", updated_at: "2026-01-01T00:00:00.000Z" }
      : null);
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["v2:scrape"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
  });

  it("enforces scoped gateway tokens on deprecated root routes too", async () => {
    const handler = createProxyHandler({ config, auditStore });
    const req = requestFor("endpoint-a", "/v1/crawl");
    delete (req as Request & { tenantEndpointId?: string }).tenantEndpointId;
    req.originalUrl = "/v1/crawl";
    const res = responseFor();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Gateway token scope does not allow this route" });
  });

  it("requires a gateway token and strips the public endpoint prefix before dispatch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from('{"success":true,"data":{"markdown":"content","metadata":{"scrapeId":"upstream-scrape-id"}}}'),
    });
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config,
      auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([{
        id: "self-a", kind: "self_hosted", baseUrl: "https://self-hosted.example", fundingType: "included",
        hardConcurrency: 1, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880,
      }]),
    });
    const res = responseFor();

    await handler(requestFor(), res);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://self-hosted.example/v2/scrape?formats=markdown",
      expect.objectContaining({ headers: expect.not.objectContaining({ authorization: "Bearer fc_gateway_token" }) }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    vi.unstubAllGlobals();
  });

  it("supports the tenant /v1 base path without forwarding its endpoint prefix", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["v1:*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from("{}") });
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config,
      auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([]),
    });

    await handler(requestFor("endpoint-a", "/v1/map"), responseFor());

    expect(fetchMock).toHaveBeenCalledWith("https://self-hosted.example/v1/map", expect.anything());
    vi.unstubAllGlobals();
  });

  it("rejects async creation when only legacy settings are available", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([]),
    });
    const res = responseFor();

    await handler(requestFor("endpoint-a", "/v2/crawl"), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Managed source unavailable for tenant async job" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not fall back to legacy Cloud settings when an async creation lacks a Cloud source", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") return { key, value: JSON.stringify(["legacy-cloud-key"]), updated_at: "2026-01-01T00:00:00.000Z" };
      return key === "self_hosted_firecrawl_url"
        ? { key, value: "https://self-hosted.example", updated_at: "2026-01-01T00:00:00.000Z" }
        : null;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([selfHostedSource()]),
    });
    const res = responseFor();

    await handler(requestFor("endpoint-a", "/v2/crawl"), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Managed source unavailable for tenant async job" });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("uses a BYOK Cloud source even when the general route mode prefers self-hosted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => Buffer.from("{}") });
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config,
      auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({
        id: "account-a", public_id: "endpoint-a", status: "active", funding_preference: "byok",
      }),
      resolveSources: vi.fn().mockResolvedValue([{
        id: "account:account-a:credential-a",
        kind: "cloud",
        baseUrl: "https://byok.firecrawl.example",
        credential: "fc_provider_credential",
        credentialId: "credential-a",
        fundingType: "byok",
        hardConcurrency: 1,
        requestTimeoutMs: 120_000,
        responseBufferMaxBytes: 5_242_880,
      }]),
    });

    await handler(requestFor(), responseFor());

    expect(fetchMock).toHaveBeenCalledWith(
      "https://byok.firecrawl.example/v2/scrape?formats=markdown",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer fc_provider_credential" }) }),
    );
    vi.unstubAllGlobals();
  });

  it("uses one opaque response for cross-account and missing endpoints", async () => {
    const handler = createProxyHandler({
      config,
      auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue(null),
      resolveSources: vi.fn().mockResolvedValue([]),
    });
    const res = responseFor();

    await handler(requestFor(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Tenant endpoint unavailable" });
  });

  it("virtualizes v1 and v2 creation responses before returning them", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    const fetchMock = vi.fn().mockResolvedValue(upstreamResponse('{"id":"upstream-job","url":"https://upstream/job"}'));
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([selfHostedSource()]),
    });

    for (const path of ["/v1/crawl", "/v2/interact"]) {
      const res = responseFor();
      await handler(requestFor("endpoint-a", path), res);
      const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString());
      expect(body.id).not.toBe("upstream-job");
      expect(body.url).toBe(`/e/endpoint-a${path}/${body.id}`);
    }
    expect(mockCreateGatewayJob).toHaveBeenCalledWith("account-a", expect.objectContaining({
      upstreamJobId: "upstream-job", sourceId: "self-a", fundingType: "included",
    }));
    vi.unstubAllGlobals();
  });

  it("virtualizes the nested scrape session ID in documented v2 scrape responses", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstreamResponse(
      '{"success":true,"data":{"markdown":"content","metadata":{"scrapeId":"upstream-scrape-id"}}}',
    )));
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([selfHostedSource()]),
    });
    const res = responseFor();

    await handler(requestFor("endpoint-a", "/v2/scrape"), res);

    const body = JSON.parse((res.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString());
    expect(body.data.metadata.scrapeId).not.toBe("upstream-scrape-id");
    expect(mockCreateGatewayJob).toHaveBeenCalledWith("account-a", expect.objectContaining({
      upstreamJobId: "upstream-scrape-id", routeFamily: "/v2/scrape", sourceId: "self-a",
    }));
    vi.unstubAllGlobals();
  });

  it("cancels an oversized buffered scrape response before retaining it", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("response body larger than the source buffer limit"));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200 })));
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([{ ...selfHostedSource(), responseBufferMaxBytes: 10 }]),
    });
    const res = responseFor();

    await handler(requestFor("endpoint-a", "/v2/scrape"), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(cancelled).toBe(true);
    vi.unstubAllGlobals();
  });

  it("rewrites lifecycle IDs and pins scrape interactions to their recorded source", async () => {
    mockGetGatewayJob.mockResolvedValue(gatewayJob("/v2/scrape"));
    const fetchMock = vi.fn().mockResolvedValue(upstreamResponse('{"status":"active"}'));
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([
        selfHostedSource(),
        { id: "cloud-a", kind: "cloud" as const, baseUrl: "https://cloud.example", credential: "cloud-key", credentialId: "credential-a", fundingType: "included" as const, hardConcurrency: 1, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880 },
      ]),
    });

    await handler(requestFor("endpoint-a", "/v2/scrape/public-job/interact", "POST"), responseFor());

    expect(fetchMock).toHaveBeenCalledWith("https://self-hosted.example/v2/scrape/upstream%2Fjob/interact", expect.anything());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("uses opaque responses for unknown or mismatched lifecycle IDs", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    mockGetGatewayJob.mockResolvedValue(null);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn(),
    });
    const res = responseFor();

    await handler(requestFor("endpoint-a", "/v1/crawl/public-job", "GET"), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "Tenant async job unavailable" });
  });

  it("returns unavailable rather than switching a disabled pinned source", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    mockGetGatewayJob.mockResolvedValue(gatewayJob("/v2/crawl"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([]),
    });
    const res = responseFor();

    await handler(requestFor("endpoint-a", "/v2/crawl/public-job", "GET"), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not retry or fall back a pinned lifecycle request", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");
    mockGetGatewayJob.mockResolvedValue(gatewayJob("/v2/crawl"));
    const fetchMock = vi.fn().mockResolvedValue(upstreamResponse('{"error":"upstream failed"}', 500));
    vi.stubGlobal("fetch", fetchMock);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([
        selfHostedSource(),
        { id: "cloud-a", kind: "cloud" as const, baseUrl: "https://cloud.example", credential: "cloud-key", credentialId: "credential-a", fundingType: "included" as const, hardConcurrency: 1, requestTimeoutMs: 120_000, responseBufferMaxBytes: 5_242_880 },
      ]),
    });

    await handler(requestFor("endpoint-a", "/v2/crawl/public-job", "GET"), responseFor());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://self-hosted.example/v2/crawl/upstream%2Fjob", expect.anything());
    vi.unstubAllGlobals();
  });

  it("marks a bounded terminal poll response complete", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    mockGetGatewayJob.mockResolvedValue(gatewayJob("/v2/crawl"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(upstreamResponse(
      '{"status":"completed"}', 200, new Headers({ "content-length": "22" }),
    )));
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([selfHostedSource()]),
    });

    await handler(requestFor("endpoint-a", "/v2/crawl/public-job", "GET"), responseFor());

    expect(mockCompleteGatewayJob).toHaveBeenCalledWith("account-a", "public-job");
    vi.unstubAllGlobals();
  });

  it("marks successful cancellation complete and never returns an unpersisted upstream ID", async () => {
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: { id: "token-a", user_id: "user-a", account_id: "account-a", scopes: ["*"] },
      user: { id: "user-a", account_id: "account-a", status: "active", suspended_until: null },
    });
    mockGetGatewayJob.mockResolvedValue(gatewayJob("/v2/interact"));
    const cancelFetch = vi.fn()
      .mockResolvedValueOnce(upstreamResponse('{"success":true}'))
      .mockResolvedValueOnce(upstreamResponse('{"id":"upstream-interact"}'));
    vi.stubGlobal("fetch", cancelFetch);
    const handler = createProxyHandler({
      config, auditStore,
      resolveEndpoint: vi.fn().mockResolvedValue({ id: "account-a", public_id: "endpoint-a", status: "active" }),
      resolveSources: vi.fn().mockResolvedValue([selfHostedSource()]),
    });

    await handler(requestFor("endpoint-a", "/v2/interact/public-job", "DELETE"), responseFor());
    expect(mockCompleteGatewayJob).toHaveBeenCalledWith("account-a", "public-job");

    mockCreateGatewayJob.mockRejectedValueOnce(new Error("database unavailable"));
    const createRes = responseFor();
    await handler(requestFor("endpoint-a", "/v2/interact"), createRes);
    expect(createRes.status).toHaveBeenCalledWith(502);
    expect((createRes.end as ReturnType<typeof vi.fn>).mock.calls[0][0].toString()).not.toContain("upstream");
    vi.unstubAllGlobals();
  });

  it("rejects endpoint-only requests before endpoint lookup", async () => {
    const resolveEndpoint = vi.fn();
    const handler = createProxyHandler({ config, auditStore, resolveEndpoint });
    const req = requestFor();
    req.headers = { "content-type": "application/json" };
    const res = responseFor();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(resolveEndpoint).not.toHaveBeenCalled();
  });
});
