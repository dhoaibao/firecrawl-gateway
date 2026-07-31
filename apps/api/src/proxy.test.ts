import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { hasSensitiveHeaders } from "./policy";
import { headersForPrivacyCheck, createProxyHandler } from "./proxy";
import type { AuditStore } from "./audit-store";
import type { GatewayConfig } from "./types";

const mockGetDefaultRouteMode = vi.hoisted(() => vi.fn());
const mockGetSetting = vi.hoisted(() => vi.fn());
const mockValidateApiKeyWithUser = vi.hoisted(() => vi.fn());
const mockTouchApiKey = vi.hoisted(() => vi.fn());

vi.mock("./settings/service", () => ({
  getSetting: mockGetSetting,
  listSettings: vi.fn(),
  setSetting: vi.fn(),
  deleteSetting: vi.fn(),
  getDefaultRouteMode: mockGetDefaultRouteMode,
  VALID_ROUTE_MODES: ["self-hosted-first", "self-hosted-only", "cloud-first", "cloud-only"],
}));

vi.mock("./api-keys/service", () => ({
  validateApiKey: vi.fn().mockResolvedValue(null),
  validateApiKeyWithUser: mockValidateApiKeyWithUser,
  touchApiKey: mockTouchApiKey,
}));

vi.mock("./users/service", () => ({
  getUserById: vi.fn(),
  checkUserAccess: vi.fn().mockReturnValue({ allowed: true }),
}));

const baseConfig: GatewayConfig = {
  port: 8080,
  cloudBaseUrl: "https://api.firecrawl.dev",
  defaultRouteMode: "self-hosted-first",
  requestTimeoutMs: 120_000,
  logFile: "/tmp/test.log",
  maxBodyBytes: 5_242_880,
  authEnabled: false,
  databaseUrl: "postgresql://localhost/test",
  operatorDatabaseUrl: "postgresql://localhost/operator-test",
  sessionSecret: "secret",
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  adminEmail: "",
  adminPassword: "",
  trustProxy: false,
};

const auditStore: AuditStore = {
  appendAudit: vi.fn().mockResolvedValue(undefined),
  readAuditEntries: vi.fn().mockResolvedValue([]),
  deleteAuditEntry: vi.fn().mockResolvedValue(false),
  deleteAuditEntriesByIds: vi.fn().mockResolvedValue(0),
  deleteAuditEntries: vi.fn().mockResolvedValue(0),
};

describe("headersForPrivacyCheck", () => {
  it("ignores gateway bearer auth when product auth is enabled", () => {
    const headers = headersForPrivacyCheck(
      { authorization: "Bearer fc_virtual_key" },
      true,
    );

    expect(hasSensitiveHeaders(headers, null)).toBe(false);
  });

  it("keeps authorization sensitive when product auth is disabled", () => {
    const headers = headersForPrivacyCheck(
      { authorization: "Bearer upstream_secret" },
      false,
    );

    expect(hasSensitiveHeaders(headers, null)).toBe(true);
  });

  it("still treats target headers in the body as sensitive", () => {
    const headers = headersForPrivacyCheck(
      { authorization: "Bearer fc_virtual_key" },
      true,
    );

    expect(
      hasSensitiveHeaders(headers, {
        headers: { Authorization: "Bearer upstream_secret" },
      }),
    ).toBe(true);
  });

  it("removes authorization case-insensitively without mutating input", () => {
    const original = { Authorization: "Bearer fc_virtual_key" };
    const headers = headersForPrivacyCheck(original, true);

    expect(headers).toEqual({});
    expect(original).toEqual({ Authorization: "Bearer fc_virtual_key" });
  });
});

describe("createProxyHandler trusted session caller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-first");
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["fc_test_key"]', updated_at: new Date().toISOString() };
      }
      return null;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("authenticates a virtual API key with its owner in one service call", async () => {
    mockTouchApiKey.mockResolvedValue(undefined);
    mockValidateApiKeyWithUser.mockResolvedValue({
      key: {
        id: "key-1",
        user_id: "user-1",
      },
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "Test User",
        password_hash: "password-hash",
        is_admin: false,
        status: "active",
        suspended_until: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({
      config: { ...baseConfig, authEnabled: true },
      auditStore,
    });
    const req = {
      method: "POST",
      url: "/v1/scrape",
      originalUrl: "/v1/scrape",
      headers: { authorization: "Bearer fc_test_key", "content-type": "application/json" },
      requestId: "req-authenticated",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ url: "https://example.com" }));
      },
      on: vi.fn(),
      pipe: vi.fn(),
    } as unknown as import("express").Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
    } as unknown as import("express").Response;

    await handler(req, res);

    expect(mockValidateApiKeyWithUser).toHaveBeenCalledWith("fc_test_key");
    expect(mockTouchApiKey).toHaveBeenCalledWith("key-1");
    expect(res.status).toHaveBeenCalledWith(200);
    expect(auditStore.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", status_code: 200 }),
    );
  });

  it("uses trusted user id and skips api key validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const trustedUserId = "session-user-123";
    const handler = createProxyHandler({
      config: { ...baseConfig, authEnabled: true },
      auditStore,
      getTrustedUserId: () => trustedUserId,
    });

    const req = {
      method: "POST",
      url: "/v1/scrape",
      originalUrl: "/v1/scrape",
      headers: { "content-type": "application/json" },
      requestId: "req-trusted",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ url: "https://example.com" }));
      },
      on: vi.fn(),
      pipe: vi.fn(),
    } as unknown as import("express").Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
    } as unknown as import("express").Response;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(auditStore.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: trustedUserId,
        backend_used: "self-hosted",
      }),
    );
  });
});

describe("createProxyHandler response streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-first");
    mockGetSetting.mockResolvedValue(null);
  });

  it("streams successful upstream responses and preserves content encoding", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-encoding": "gzip" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed response"));
          controller.close();
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: baseConfig, auditStore });
    const req = {
      method: "GET",
      url: "/v1/scrape",
      originalUrl: "/v1/scrape",
      headers: {},
      requestId: "req-stream",
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as import("express").Request;
    const res = new PassThrough() as PassThrough & {
      status: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    res.status = vi.fn().mockReturnValue(res);
    res.set = vi.fn().mockReturnValue(res);

    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    await handler(req, res as unknown as import("express").Response);

    expect(Buffer.concat(chunks).toString()).toBe("streamed response");
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ "content-encoding": "gzip" }));
  });
});

describe("createProxyHandler route mode resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-first");
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["fc_test_key"]', updated_at: new Date().toISOString() };
      }
      return null;
    });
  });

  it("uses the database setting as the default route mode", async () => {
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: baseConfig, auditStore });
    const req = {
      method: "POST",
      url: "/v1/scrape",
      originalUrl: "/v1/scrape",
      headers: { "content-type": "application/json" },
      requestId: "req-1",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ url: "https://example.com" }));
      },
      on: vi.fn(),
      pipe: vi.fn(),
    } as unknown as import("express").Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
    } as unknown as import("express").Response;

    await handler(req, res);

    expect(mockGetDefaultRouteMode).toHaveBeenCalledWith("self-hosted-first");
    expect(fetchMock).toHaveBeenCalled();
    const callUrl = fetchMock.mock.calls[0]?.[0];
    expect(callUrl).toContain("api.firecrawl.dev");
    expect(auditStore.appendAudit).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("writes an audit entry when a cloud-first request is rejected for invalid JSON", async () => {
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: baseConfig, auditStore });
    const req = {
      method: "POST",
      url: "/v1/scrape",
      originalUrl: "/v1/scrape",
      headers: { "content-type": "application/json" },
      requestId: "req-invalid-json",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from('{"url":');
      },
      on: vi.fn(),
      pipe: vi.fn(),
    } as unknown as import("express").Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as import("express").Response;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Invalid JSON body" }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditStore.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        route_mode: "cloud-first",
        backend_used: "none",
        status_code: 400,
        request_id: "req-invalid-json",
      }),
    );

    vi.unstubAllGlobals();
  });

  it("returns 400 for an invalid request URL", async () => {
    const handler = createProxyHandler({ config: baseConfig, auditStore });
    const req = {
      method: "POST",
      url: "http://[::1",
      originalUrl: "http://[::1",
      headers: {},
      requestId: "req-bad-url",
    } as unknown as import("express").Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as import("express").Response;

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Invalid request URL" }));
  });

  it("uses the env default as the resolved route mode when database setting is unset", async () => {
    mockGetDefaultRouteMode.mockResolvedValue("self-hosted-only");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: { ...baseConfig, defaultRouteMode: "self-hosted-only" }, auditStore });
    const req = {
      method: "POST",
      url: "/v1/scrape",
      originalUrl: "/v1/scrape",
      headers: { "content-type": "application/json" },
      requestId: "req-2",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ url: "https://example.com" }));
      },
      on: vi.fn(),
      pipe: vi.fn(),
    } as unknown as import("express").Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
    } as unknown as import("express").Response;

    await handler(req, res);

    expect(mockGetDefaultRouteMode).toHaveBeenCalledWith("self-hosted-only");

    vi.unstubAllGlobals();
  });
});

describe("createProxyHandler cloud quota fallback to self-hosted", () => {
  const cloudFirstConfig: GatewayConfig = { ...baseConfig, defaultRouteMode: "cloud-first" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDefaultRouteMode.mockResolvedValue("cloud-first");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeRequest(body?: object) {
    return {
      method: "POST",
      url: "/v1/scrape",
      originalUrl: "/v1/scrape",
      headers: { "content-type": "application/json" },
      requestId: "req-cloud-quota",
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify(body ?? { url: "https://example.com" }));
      },
      on: vi.fn(),
      pipe: vi.fn(),
    } as unknown as import("express").Request;
  }

  function makeResponse() {
    return {
      status: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
    } as unknown as import("express").Response;
  }

  it("uses the cloud key with the most remaining credit first", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["low-credit","high-credit"]', updated_at: new Date().toISOString() };
      }
      return null;
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes("/v2/team/credit-usage")) {
        const apiKey = new Headers(options?.headers).get("authorization");
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { remainingCredits: apiKey?.includes("high-credit") ? 1000 : 100 } }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: cloudFirstConfig, auditStore });
    const res = makeResponse();
    await handler(makeRequest(), res);

    const cloudRequest = fetchMock.mock.calls.find(([url]) => url === "https://api.firecrawl.dev/v1/scrape");
    expect(fetchMock.mock.calls.map(([url, options]) => [url, new Headers(options?.headers).get("authorization")])).toEqual([
      ["https://api.firecrawl.dev/v2/team/credit-usage", "Bearer low-credit"],
      ["https://api.firecrawl.dev/v2/team/credit-usage", "Bearer high-credit"],
      ["https://api.firecrawl.dev/v1/scrape", "Bearer high-credit"],
    ]);
    expect(new Headers(cloudRequest?.[1]?.headers).get("authorization")).toBe("Bearer high-credit");
  });

  it("falls back to self-hosted when every cloud API key returns 429", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["key1","key2"]', updated_at: new Date().toISOString() };
      }
      if (key === "self_hosted_firecrawl_url") {
        return { key, value: "http://localhost:3002", updated_at: new Date().toISOString() };
      }
      return null;
    });

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("api.firecrawl.dev")) {
        return {
          ok: false,
          status: 429,
          headers: new Headers(),
          arrayBuffer: async () => Buffer.from(JSON.stringify({ success: false, error: "Quota exceeded" })),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true, selfHosted: true })),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: cloudFirstConfig, auditStore });
    const res = makeResponse();
    await handler(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const selfHostedCall = fetchMock.mock.calls.find(([url]) => url.includes("localhost:3002"));
    expect(selfHostedCall).toBeDefined();
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "x-hybrid-firecrawl-backend": "self-hosted",
        "x-hybrid-firecrawl-fallback": "true",
      }),
    );
  });

  it("does not fall back to self-hosted when a later cloud key succeeds", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["key1","key2"]', updated_at: new Date().toISOString() };
      }
      return null;
    });

    let cloudCall = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("api.firecrawl.dev")) {
        cloudCall += 1;
        if (cloudCall === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Headers(),
            arrayBuffer: async () => Buffer.from(JSON.stringify({ success: false, error: "Quota exceeded" })),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true })),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        arrayBuffer: async () => Buffer.from(JSON.stringify({ success: true, selfHosted: true })),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: cloudFirstConfig, auditStore });
    const res = makeResponse();
    await handler(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const selfHostedCall = fetchMock.mock.calls.find(([url]) => url.includes("localhost:3002"));
    expect(selfHostedCall).toBeUndefined();
  });

  it("does not fall back to self-hosted for non-quota cloud errors", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["key1"]', updated_at: new Date().toISOString() };
      }
      return null;
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: false, error: "Unauthorized" })),
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createProxyHandler({ config: cloudFirstConfig, auditStore });
    const res = makeResponse();
    await handler(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to self-hosted for cloud-only requests", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["key1"]', updated_at: new Date().toISOString() };
      }
      return null;
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ success: false, error: "Quota exceeded" })),
    });
    vi.stubGlobal("fetch", fetchMock);

    mockGetDefaultRouteMode.mockResolvedValue("cloud-only");
    const cloudOnlyConfig: GatewayConfig = { ...baseConfig, defaultRouteMode: "cloud-only" };
    const handler = createProxyHandler({ config: cloudOnlyConfig, auditStore });
    const res = makeResponse();
    await handler(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
