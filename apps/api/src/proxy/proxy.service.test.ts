import { Writable } from "node:stream";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestWithContext } from "../common/types";
import * as cryptoModule from "../common/crypto";
import { encryptSettingValue } from "../common/crypto";
import { CircuitBreaker } from "./circuit-breaker";
import { isSelfHostedUnavailable } from "./policy";
import { ProxyService } from "./proxy.service";

const config = {
  cloudBaseUrl: "https://cloud.test",
  selfHostedBaseUrl: "https://self.test",
  requestTimeoutMs: 1_000,
  maxBodyBytes: 1_024 * 1_024,
  selfHostedBreakerFailureThreshold: 3,
  selfHostedBreakerCooldownMs: 30_000,
  authEnabled: false,
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

function makeRequest(overrides: Record<string, unknown> = {}): RequestWithContext {
  return {
    method: "POST",
    raw: { url: "/v1/test" },
    url: "/v1/test",
    headers: {},
    body: undefined,
    rawBody: Buffer.alloc(0),
    requestId: "request-1",
    ...overrides,
  } as unknown as RequestWithContext;
}

function makeReply(events: string[] = []) {
  const raw = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as Writable & { writeHead: ReturnType<typeof vi.fn> };
  raw.writeHead = vi.fn();
  const reply = {
    code: vi.fn(),
    headers: vi.fn(),
    send: vi.fn(),
    hijack: vi.fn(),
    raw,
  };
  reply.code.mockReturnValue(reply);
  reply.headers.mockReturnValue(reply);
  reply.send.mockImplementation(() => {
    events.push("reply-sent");
    return reply;
  });
  return reply;
}

function settingsWith(
  records: Record<string, { key: string; value: string; updated_at?: string } | null> = {},
  routeMode?: string,
) {
  const all = {
    default_route_mode: routeMode
      ? { key: "default_route_mode", value: routeMode, updated_at: "2026-01-01T00:00:00.000Z" }
      : null,
    firecrawl_api_keys: null,
    ...records,
  };
  return {
    getSettings: vi.fn().mockImplementation(async () => all),
    setSetting: vi.fn(),
    replaceSettingIfUnchanged: vi.fn().mockResolvedValue(true),
  };
}

function makeSettings() {
  return settingsWith({}, "self-hosted-only");
}

function makeCredits() {
  return {
    reserve: vi.fn(),
    recordResponse: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMetrics() {
  return {
    observeRequest: vi.fn(),
    recordRateLimited: vi.fn(),
    recordCircuitTransition: vi.fn(),
    recordCircuitRejected: vi.fn(),
    recordResponseCache: vi.fn(),
  };
}

function makeService(
  settings = makeSettings(),
  audit = { appendAudit: vi.fn().mockResolvedValue(undefined) },
  credits = makeCredits(),
) {
  return new ProxyService(
    config as never,
    settings as never,
    { validateApiKey: vi.fn() } as never,
    audit as never,
    credits as never,
    makeMetrics() as never,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ProxyService", () => {
  it("sends the response before the audit insert settles, but waits for the insert", async () => {
    const events: string[] = [];
    let resolveAudit!: () => void;
    const auditDone = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const audit = {
      appendAudit: vi.fn(async () => {
        events.push("audit-started");
        await auditDone;
        events.push("audit-settled");
      }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const service = makeService(makeSettings(), audit);
    const reply = makeReply(events);

    const handled = service.handle(makeRequest(), reply as never);
    // Poll rather than count microtask ticks, which shifts with every internal await.
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));

    expect(events).toEqual(["audit-started", "reply-sent"]);
    let returned = false;
    void handled.then(() => {
      returned = true;
    });
    await Promise.resolve();
    expect(returned).toBe(false);

    resolveAudit();
    await handled;
    expect(events).toEqual(["audit-started", "reply-sent", "audit-settled"]);
  });

  it("does not fail the response when an audit insert unexpectedly rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const audit = { appendAudit: vi.fn().mockRejectedValue(new Error("audit unavailable")) };
    const service = makeService(makeSettings(), audit);
    const reply = makeReply();

    await expect(service.handle(makeRequest(), reply as never)).resolves.toBeUndefined();
    expect(reply.send).toHaveBeenCalledTimes(1);
  });

  it("persists the audit insert before sending an early 409 rejection response", async () => {
    const events: string[] = [];
    let resolveAudit!: () => void;
    const auditDone = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const audit = {
      appendAudit: vi.fn(async () => {
        events.push("audit-started");
        await auditDone;
        events.push("audit-settled");
      }),
    };
    const service = makeService(makeSettings(), audit);
    const reply = makeReply(events);
    const req = makeRequest({ raw: { url: "/v1/agent" }, url: "/v1/agent" });

    const handled = service.handle(req, reply as never);
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));

    expect(events).toEqual(["audit-started"]);
    expect(reply.send).not.toHaveBeenCalled();

    resolveAudit();
    await handled;
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(events).toEqual(["audit-started", "audit-settled", "reply-sent"]);
  });

  it("persists the audit insert before sending an early 401 response", async () => {
    const events: string[] = [];
    let resolveAudit!: () => void;
    const auditDone = new Promise<void>((resolve) => {
      resolveAudit = resolve;
    });
    const audit = {
      appendAudit: vi.fn(async () => {
        events.push("audit-started");
        await auditDone;
        events.push("audit-settled");
      }),
    };
    const authConfig = { ...config, authEnabled: true };
    const service = new ProxyService(
      authConfig as never,
      makeSettings() as never,
      { validateApiKey: vi.fn() } as never,
      audit as never,
      makeCredits() as never,
      makeMetrics() as never,
    );
    const reply = makeReply(events);
    const req = makeRequest({ headers: {} });

    const handled = service.handle(req, reply as never);
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));

    expect(events).toEqual(["audit-started"]);
    expect(reply.send).not.toHaveBeenCalled();

    resolveAudit();
    await handled;
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(events).toEqual(["audit-started", "audit-settled", "reply-sent"]);
  });

  it("does not fail early rejection response when audit insert unexpectedly rejects", async () => {
    const audit = { appendAudit: vi.fn().mockRejectedValue(new Error("audit database down")) };
    const service = makeService(makeSettings(), audit);
    const reply = makeReply();
    const req = makeRequest({ raw: { url: "/v1/agent" }, url: "/v1/agent" });

    await expect(service.handle(req, reply as never)).resolves.toBeUndefined();
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledTimes(1);
  });

  it("loads all settings in one call, concurrently with API-key validation", async () => {
    let resolveSettings!: (value: Record<string, unknown>) => void;
    let resolveKey!: (value: { id: string }) => void;
    const settings = {
      getSettings: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            resolveSettings = resolve;
          }),
      ),
      setSetting: vi.fn(),
    };
    const keys = {
      validateApiKey: vi.fn(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveKey = resolve;
          }),
      ),
      touchApiKey: vi.fn().mockResolvedValue(undefined),
    };
    const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ProxyService(
      { ...config, authEnabled: true } as never,
      settings as never,
      keys as never,
      audit as never,
      makeCredits() as never,
      makeMetrics() as never,
    );

    const handled = service.handle(
      makeRequest({ headers: { authorization: "Bearer gw_key" } }),
      makeReply() as never,
    );
    await Promise.resolve();

    expect(settings.getSettings).toHaveBeenCalledTimes(1);
    expect(settings.getSettings).toHaveBeenCalledWith([
      "default_route_mode",
      "firecrawl_api_keys",
      "response_cache_ttl_seconds",
    ]);
    expect(keys.validateApiKey).toHaveBeenCalledWith("gw_key");

    resolveKey({ id: "key-1" });
    resolveSettings({
      default_route_mode: { key: "default_route_mode", value: "self-hosted-only" },
      firecrawl_api_keys: null,
    });
    await handled;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://self.test/v1/test",
      expect.objectContaining({ method: "POST" }),
    );
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ route_mode: "self-hosted-only" }),
    );
    expect(keys.touchApiKey).toHaveBeenCalledWith("key-1");
  });

  it("rejects a missing or invalid API key with the resolved route mode and no upstream call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [headers, reason] of [
      [{}, "Missing or invalid API key"],
      [{ authorization: "Bearer bad" }, "Invalid or revoked API key"],
    ] as const) {
      const keys = { validateApiKey: vi.fn().mockResolvedValue(null), touchApiKey: vi.fn() };
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const service = new ProxyService(
        { ...config, authEnabled: true } as never,
        makeSettings() as never,
        keys as never,
        audit as never,
        makeCredits() as never,
        makeMetrics() as never,
      );
      const reply = makeReply();

      await service.handle(makeRequest({ headers }), reply as never);

      expect(reply.code).toHaveBeenCalledWith(401);
      expect(audit.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          status_code: 401,
          route_mode: "self-hosted-only",
          fallback_reason: reason,
        }),
      );
      expect(keys.touchApiKey).not.toHaveBeenCalled();
      expect(keys.validateApiKey).toHaveBeenCalledTimes(headers.authorization ? 1 : 0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("migrates a legacy plaintext cloud-key record only if it is unchanged, never via an unconditional write", async () => {
    const key = "fc_cloud_key_1234567890";
    const plaintext = JSON.stringify([key]);
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: plaintext } },
      "cloud-only",
    );
    const credits = makeCredits();
    credits.reserve.mockResolvedValue({ key, keyId: "opaque-key-id", amount: 1, source: "local" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await makeService(settings, undefined, credits).handle(makeRequest(), makeReply() as never);

    expect(settings.replaceSettingIfUnchanged).toHaveBeenCalledWith(
      "firecrawl_api_keys",
      plaintext,
      expect.not.stringContaining(key),
    );
    expect(settings.setSetting).not.toHaveBeenCalled();
    expect(credits.reserve).toHaveBeenCalledWith([key], 1, expect.any(Set));
  });

  it("reserves a configured cloud key before proxying and never fetches credit usage on a normal request", async () => {
    const key = "fc_cloud_key_1234567890";
    const encrypted = encryptSettingValue(JSON.stringify([key]), config.firecrawlKeysEncryptionKey);
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: encrypted } },
      "cloud-first",
    );
    const credits = makeCredits();
    credits.reserve.mockResolvedValue({ key, keyId: "opaque-key-id", amount: 1, source: "local" });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = makeService(settings, undefined, credits);
    await service.handle(makeRequest(), makeReply() as never);

    expect(credits.reserve).toHaveBeenCalledWith([key], 1, expect.any(Set));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.test/v1/test",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${key}` }),
      }),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/v2/team/credit-usage")),
    ).toBe(false);
  });

  it("reuses parsed cloud keys until the stored setting value changes, without sharing the array", async () => {
    const first = "fc_cloud_key_1234567890";
    const second = "fc_cloud_key_0987654321";
    const encode = (key: string) =>
      encryptSettingValue(JSON.stringify([key]), config.firecrawlKeysEncryptionKey);
    let record = { key: "firecrawl_api_keys", value: encode(first) };
    const settings = settingsWith({}, "cloud-first");
    settings.getSettings.mockImplementation(async () => ({
      default_route_mode: {
        key: "default_route_mode",
        value: "cloud-first",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      firecrawl_api_keys: record,
    }));
    const decrypt = vi.spyOn(cryptoModule, "decryptSettingValue");
    const credits = makeCredits();
    credits.reserve.mockImplementation(async (keys: string[]) => {
      const reservation = { key: keys[0], keyId: "opaque-key-id", amount: 1, source: "local" };
      keys.push("mutated-by-caller");
      return reservation;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response(null, { status: 204 })),
    );
    const service = makeService(settings, undefined, credits);

    await service.handle(makeRequest(), makeReply() as never);
    await service.handle(makeRequest(), makeReply() as never);
    expect(decrypt).toHaveBeenCalledTimes(1);
    record = { key: "firecrawl_api_keys", value: encode(second) };
    await service.handle(makeRequest(), makeReply() as never);

    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(credits.reserve.mock.calls.map(([keys]) => keys[0])).toEqual([first, first, second]);
  });

  it("observes streamed actual credits without delaying the client response", async () => {
    const key = "fc_cloud_key_1234567890";
    const encrypted = encryptSettingValue(JSON.stringify([key]), config.firecrawlKeysEncryptionKey);
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: encrypted } },
      "cloud-only",
    );
    const credits = makeCredits();
    credits.reserve.mockResolvedValue({
      key,
      keyId: "opaque-key-id",
      amount: 1,
      source: "redis",
      reservationKey: "reservation-key",
    });
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    credits.recordResponse.mockImplementation(
      (_reservation: unknown, _status: number, actualCreditsUsed?: number) =>
        actualCreditsUsed === 3 ? settlement : Promise.resolve(),
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"metadata":{"cred'));
        controller.enqueue(new TextEncoder().encode('itsUsed":3}}'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
        ),
    );

    const service = makeService(settings, undefined, credits);
    const handled = service.handle(makeRequest(), makeReply() as never);
    const outcome = await Promise.race([
      handled.then(() => "handled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    expect(outcome).toBe("handled");
    expect(credits.recordResponse).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: "opaque-key-id" }),
      200,
      3,
    );
    resolveSettlement();
  });

  it("does not observe non-JSON streams for creditsUsed", async () => {
    const key = "fc_cloud_key_1234567890";
    const encrypted = encryptSettingValue(JSON.stringify([key]), config.firecrawlKeysEncryptionKey);
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: encrypted } },
      "cloud-only",
    );
    const credits = makeCredits();
    credits.reserve.mockResolvedValue({
      key,
      keyId: "opaque-key-id",
      amount: 1,
      source: "redis",
      reservationKey: "reservation-key",
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"metadata":{"creditsUsed":3}}'));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(stream, { status: 200, headers: { "content-type": "text/plain" } }),
        ),
    );

    const service = makeService(settings, undefined, credits);
    await service.handle(makeRequest(), makeReply() as never);

    expect(credits.recordResponse).not.toHaveBeenCalled();
  });

  it("disables a 402 key and retries the request with another reserved key", async () => {
    const keys = ["fc_cloud_key_1111111111", "fc_cloud_key_2222222222"];
    const encrypted = encryptSettingValue(JSON.stringify(keys), config.firecrawlKeysEncryptionKey);
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: encrypted } },
      "cloud-only",
    );
    const credits = makeCredits();
    credits.reserve
      .mockResolvedValueOnce({ key: keys[0], keyId: "opaque-1", amount: 1, source: "local" })
      .mockResolvedValueOnce({ key: keys[1], keyId: "opaque-2", amount: 1, source: "local" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("credits exhausted", { status: 402 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = makeService(settings, undefined, credits);
    await service.handle(makeRequest(), makeReply() as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${keys[0]}` }),
      }),
    );
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${keys[1]}` }),
      }),
    );
    expect(credits.recordResponse).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: "opaque-1" }),
      402,
    );
  });

  it("ignores client route-mode overrides and does not forward the routeMode query", async () => {
    const credits = makeCredits();
    const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await makeService(makeSettings(), audit, credits).handle(
      makeRequest({
        raw: { url: "/v1/test?routeMode=cloud-only&x=1" },
        url: "/v1/test?routeMode=cloud-only&x=1",
        headers: { "x-firecrawl-route-mode": "cloud-only" },
      }),
      makeReply() as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://self.test/v1/test?x=1");
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("x-firecrawl-route-mode");
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ route_mode: "self-hosted-only", backend_used: "self-hosted" }),
    );
  });

  it("never forwards the admin session cookie upstream and ignores it for fallback", async () => {
    const key = "fc_cloud_key_1234567890";
    const encrypted = encryptSettingValue(JSON.stringify([key]), config.firecrawlKeysEncryptionKey);
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: encrypted } },
      "self-hosted-first",
    );
    const credits = makeCredits();
    credits.reserve.mockResolvedValue({ key, keyId: "opaque-key-id", amount: 1, source: "local" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ProxyService(
      { ...config, authEnabled: true } as never,
      settings as never,
      { validateApiKey: vi.fn() } as never,
      { appendAudit: vi.fn().mockResolvedValue(undefined) } as never,
      credits as never,
      makeMetrics() as never,
    );

    await service.handle(
      makeRequest({
        admin: { email: "admin@example.com" },
        headers: { cookie: "firecrawl.sid=session-value", "x-trace": "1" },
      }),
      makeReply() as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://self.test/v1/test");
    expect(fetchMock.mock.calls[1][0]).toBe("https://cloud.test/v1/test");
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).not.toHaveProperty("cookie");
      expect(init.headers).toHaveProperty("x-trace", "1");
    }
  });

  it("drops content-encoding from streamed and buffered responses because fetch already decoded them", async () => {
    for (const [status, init] of [
      [200, "streamed"],
      [404, "buffered"],
    ] as const) {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('{"success":true}', {
          status,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "x-upstream": init,
          },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const reply = makeReply();

      await makeService().handle(makeRequest(), reply as never);

      const headers = (reply.raw.writeHead.mock.calls[0]?.[1] ??
        reply.headers.mock.calls[0]?.[0]) as Record<string, string>;
      expect(headers).toBeDefined();
      expect(headers).toHaveProperty("x-upstream", init);
      expect(headers).not.toHaveProperty("content-encoding");
    }
  });

  it("drops client cookies upstream but still treats them as sensitive for fallback", async () => {
    const key = "fc_cloud_key_1234567890";
    const encrypted = encryptSettingValue(JSON.stringify([key]), config.firecrawlKeysEncryptionKey);
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: encrypted } },
      "self-hosted-first",
    );
    const credits = makeCredits();
    credits.reserve.mockResolvedValue({ key, keyId: "opaque-key-id", amount: 1, source: "local" });
    const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await makeService(settings, undefined, credits).handle(
      makeRequest({ headers: { cookie: "a=b" } }),
      makeReply() as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty("cookie");
    expect(credits.reserve).not.toHaveBeenCalled();
  });
});

describe("ProxyService routing outcomes", () => {
  const KEYS = ["fc_cloud_key_1111111111", "fc_cloud_key_2222222222"];

  function cloudSettings(keys: (string | { key: string; role: string })[], mode: string) {
    const encrypted = encryptSettingValue(JSON.stringify(keys), config.firecrawlKeysEncryptionKey);
    return settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: encrypted } },
      mode,
    );
  }

  function creditsReserving(...keys: string[]) {
    const credits = makeCredits();
    keys.forEach((key, index) =>
      credits.reserve.mockResolvedValueOnce({
        key,
        keyId: `opaque-${index + 1}`,
        amount: 1,
        source: "local",
      }),
    );
    credits.reserve.mockResolvedValue(null);
    return credits;
  }

  async function run(
    settings: ReturnType<typeof settingsWith>,
    credits = makeCredits(),
    request: Record<string, unknown> = {},
  ) {
    const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
    const reply = makeReply();
    await makeService(settings as never, audit, credits).handle(
      makeRequest(request),
      reply as never,
    );
    // Streamed responses write their head to the raw socket, buffered ones use reply.headers.
    const headers = (reply.raw.writeHead.mock.calls[0]?.[1] ??
      reply.headers.mock.calls[0]?.[0] ??
      {}) as Record<string, string>;
    return { reply, audit, headers, entry: audit.appendAudit.mock.calls[0]?.[0] };
  }

  it("falls back to self-hosted when cloud-first has no reservable credit pool", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { headers, entry } = await run(cloudSettings(KEYS, "cloud-first"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://self.test/v1/test");
    expect(headers).toMatchObject({
      "x-hybrid-firecrawl-backend": "self-hosted",
      "x-hybrid-firecrawl-fallback": "true",
      "x-hybrid-firecrawl-fallback-reason":
        "No available Firecrawl Cloud credit pool; falling back to self-hosted",
    });
    expect(entry).toMatchObject({ backend_used: "self-hosted", fallback_used: true });
  });

  it("answers 429 without any upstream call when cloud-only has no reservable credit pool", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { reply, entry } = await run(cloudSettings(KEYS, "cloud-only"));

    expect(reply.code).toHaveBeenCalledWith(429);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(entry).toMatchObject({
      status_code: 429,
      backend_used: "cloud",
      fallback_used: false,
      fallback_reason: "No available Firecrawl Cloud credit pool",
    });
  });

  it("answers 502 without any upstream call when Cloud is required and no key is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { reply, entry } = await run(settingsWith({}, "cloud-only"));

    expect(reply.code).toHaveBeenCalledWith(502);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(entry).toMatchObject({ status_code: 502, backend_used: "none" });
  });

  it("falls back from a failing self-hosted to Cloud and records the failure as the reason", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { headers, entry } = await run(
      cloudSettings(KEYS, "self-hosted-first"),
      creditsReserving(KEYS[0]),
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://self.test/v1/test",
      "https://cloud.test/v1/test",
    ]);
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      authorization: `Bearer ${KEYS[0]}`,
    });
    expect(headers).toMatchObject({
      "x-hybrid-firecrawl-backend": "cloud",
      "x-hybrid-firecrawl-fallback": "true",
      "x-hybrid-firecrawl-fallback-reason": "connect ECONNREFUSED",
    });
    expect(entry).toMatchObject({ backend_used: "cloud", fallback_used: true });
  });

  it("returns the self-hosted failure when self-hosted-first has no Cloud key to fall back to", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const credits = makeCredits();

    const { reply, entry } = await run(settingsWith({}, "self-hosted-first"), credits);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(503);
    expect(entry).toMatchObject({ status_code: 503, backend_used: "self-hosted" });
  });

  it("rotates to the next Cloud key after a 429 and reports why", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const credits = creditsReserving(...KEYS);

    const { headers, entry } = await run(cloudSettings(KEYS, "cloud-only"), credits);

    expect(
      fetchMock.mock.calls.map(
        ([, init]) => (init.headers as Record<string, string>).authorization,
      ),
    ).toEqual(KEYS.map((key) => `Bearer ${key}`));
    expect(credits.recordResponse).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: "opaque-1" }),
      429,
    );
    expect(headers).toMatchObject({
      "x-hybrid-firecrawl-fallback": "true",
      "x-hybrid-firecrawl-fallback-reason": "primary cloud key failed with 429, next key succeeded",
    });
    expect(entry).toMatchObject({ status_code: 200, backend_used: "cloud", fallback_used: true });
  });

  it("falls back to self-hosted once every Cloud key is out of quota (cloud-first)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("limit", { status: 429 }))
      .mockResolvedValueOnce(new Response("limit", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { headers, entry } = await run(
      cloudSettings(KEYS, "cloud-first"),
      creditsReserving(...KEYS),
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://cloud.test/v1/test",
      "https://cloud.test/v1/test",
      "https://self.test/v1/test",
    ]);
    expect(headers).toMatchObject({
      "x-hybrid-firecrawl-backend": "self-hosted",
      "x-hybrid-firecrawl-fallback-reason":
        "all 2 cloud API key(s) are unavailable (429); falling back to self-hosted",
    });
    expect(entry).toMatchObject({ backend_used: "self-hosted", fallback_used: true });
  });

  it("returns the last Cloud quota error when cloud-only runs out of keys", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("no credits", { status: 402 }))
      .mockResolvedValueOnce(new Response("limit", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const { reply, entry } = await run(
      cloudSettings(KEYS, "cloud-only"),
      creditsReserving(...KEYS),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reply.code).toHaveBeenCalledWith(429);
    expect(entry).toMatchObject({ status_code: 429, backend_used: "cloud", fallback_used: false });
  });

  describe("hybrid mode", () => {
    const CLOUD_KEY = "fc_cloud_role_key_111111";
    const FALLBACK_KEY = "fc_fallback_role_key_2222";
    const HYBRID_KEYS = [CLOUD_KEY, { key: FALLBACK_KEY, role: "fallback" }];

    /** Hands out one reservation per call, in order; null means no reservable key. */
    function reservations(...keys: (string | null)[]) {
      const credits = makeCredits();
      keys.forEach((key, index) =>
        credits.reserve.mockResolvedValueOnce(
          key ? { key, keyId: `opaque-${index + 1}`, amount: 1, source: "local" } : null,
        ),
      );
      credits.reserve.mockResolvedValue(null);
      return credits;
    }

    const bearers = (fetchMock: ReturnType<typeof vi.fn>) =>
      fetchMock.mock.calls.map(
        ([, init]) => (init.headers as Record<string, string>).authorization,
      );

    it("serves from a cloud-role key and keeps fallback keys out of the first pool", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const credits = reservations(CLOUD_KEY);

      const { headers, entry } = await run(cloudSettings(HYBRID_KEYS, "hybrid"), credits);

      expect(credits.reserve).toHaveBeenCalledTimes(1);
      expect(credits.reserve).toHaveBeenCalledWith([CLOUD_KEY], 1, expect.any(Set));
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://cloud.test/v1/test"]);
      expect(headers).toMatchObject({
        "x-hybrid-firecrawl-backend": "cloud",
        "x-hybrid-firecrawl-fallback": "false",
      });
      expect(entry).toMatchObject({ route_mode: "hybrid", backend_used: "cloud" });
    });

    it("uses self-hosted once cloud-role credit is out", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const { headers, entry } = await run(cloudSettings(HYBRID_KEYS, "hybrid"), reservations());

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://self.test/v1/test"]);
      expect(headers).toMatchObject({
        "x-hybrid-firecrawl-backend": "self-hosted",
        "x-hybrid-firecrawl-fallback-reason":
          "No available Firecrawl Cloud credit pool; falling back to self-hosted",
      });
      expect(entry).toMatchObject({ backend_used: "self-hosted", fallback_used: true });
    });

    it("uses self-hosted when a cloud-role key answers out of quota", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("limit", { status: 429 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const { entry } = await run(cloudSettings(HYBRID_KEYS, "hybrid"), reservations(CLOUD_KEY));

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://cloud.test/v1/test",
        "https://self.test/v1/test",
      ]);
      expect(entry).toMatchObject({ backend_used: "self-hosted", fallback_used: true });
    });

    it("uses a fallback key when self-hosted also fails after cloud credit ran out", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const credits = reservations(null, FALLBACK_KEY);

      const { headers, entry } = await run(cloudSettings(HYBRID_KEYS, "hybrid"), credits);

      expect(credits.reserve.mock.calls.map(([keys]) => keys)).toEqual([
        [CLOUD_KEY],
        [FALLBACK_KEY],
      ]);
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://self.test/v1/test",
        "https://cloud.test/v1/test",
      ]);
      expect(bearers(fetchMock)[1]).toBe(`Bearer ${FALLBACK_KEY}`);
      expect(headers).toMatchObject({
        "x-hybrid-firecrawl-backend": "cloud",
        "x-hybrid-firecrawl-fallback": "true",
        "x-hybrid-firecrawl-fallback-reason": "self-hosted returned 503; using fallback API key",
      });
      expect(entry).toMatchObject({ status_code: 200, backend_used: "cloud", fallback_used: true });
    });

    it("never retries self-hosted or the reserve twice when everything is exhausted", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response("limit", { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);

      const { reply, entry } = await run(
        cloudSettings(HYBRID_KEYS, "hybrid"),
        reservations(null, FALLBACK_KEY),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reply.code).toHaveBeenCalledWith(429);
      expect(entry).toMatchObject({ backend_used: "cloud", status_code: 429 });
    });

    it("sends a Cloud-required request to a fallback key when cloud credit is out", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const credits = reservations(null, FALLBACK_KEY);

      const { headers, entry } = await run(cloudSettings(HYBRID_KEYS, "hybrid"), credits, {
        raw: { url: "/v1/agent" },
        url: "/v1/agent",
      });

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://cloud.test/v1/agent"]);
      expect(bearers(fetchMock)).toEqual([`Bearer ${FALLBACK_KEY}`]);
      expect(headers).toMatchObject({
        "x-hybrid-firecrawl-fallback-reason":
          "No available Firecrawl Cloud credit pool; using fallback API key",
      });
      expect(entry).toMatchObject({ backend_used: "cloud", fallback_used: true });
    });

    it("answers 429 for a Cloud-required request when no key at all has credit", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { reply } = await run(cloudSettings(HYBRID_KEYS, "hybrid"), reservations(), {
        raw: { url: "/v1/agent" },
        url: "/v1/agent",
      });

      expect(reply.code).toHaveBeenCalledWith(429);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not send a sensitive request to a fallback key after a self-hosted failure", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);
      const credits = reservations();

      const { reply, entry } = await run(cloudSettings(HYBRID_KEYS, "hybrid"), credits, {
        headers: { cookie: "session=1" },
      });

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://self.test/v1/test"]);
      expect(credits.reserve).toHaveBeenCalledTimes(1);
      expect(reply.code).toHaveBeenCalledWith(503);
      expect(entry).toMatchObject({ backend_used: "self-hosted", fallback_used: true });
    });

    it("starts on self-hosted and backs up to the fallback key when only fallback keys exist", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const credits = reservations(FALLBACK_KEY);

      const { entry } = await run(
        cloudSettings([{ key: FALLBACK_KEY, role: "fallback" }], "hybrid"),
        credits,
      );

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://self.test/v1/test",
        "https://cloud.test/v1/test",
      ]);
      expect(credits.reserve).toHaveBeenCalledWith([FALLBACK_KEY], 1, expect.any(Set));
      expect(entry).toMatchObject({ backend_used: "cloud", fallback_used: true });
    });

    it("does not send the request back to self-hosted once the only fallback keys are out of quota", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(new Response("no credits", { status: 402 }));
      vi.stubGlobal("fetch", fetchMock);

      const { reply, entry } = await run(
        cloudSettings([{ key: FALLBACK_KEY, role: "fallback" }], "hybrid"),
        reservations(FALLBACK_KEY),
      );

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "https://self.test/v1/test",
        "https://cloud.test/v1/test",
      ]);
      expect(reply.code).toHaveBeenCalledWith(402);
      expect(entry).toMatchObject({ backend_used: "cloud", status_code: 402 });
    });

    it("serves from self-hosted without any key configured", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const { entry } = await run(settingsWith({}, "hybrid"));

      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["https://self.test/v1/test"]);
      expect(entry).toMatchObject({ backend_used: "self-hosted", fallback_used: false });
    });

    it("ignores roles outside hybrid and uses every key as one pool", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
      const credits = reservations(CLOUD_KEY);

      await run(cloudSettings(HYBRID_KEYS, "cloud-first"), credits);

      expect(credits.reserve).toHaveBeenCalledWith([CLOUD_KEY, FALLBACK_KEY], 1, expect.any(Set));
    });
  });

  it("warns once, without key material, when the stored Cloud keys cannot be loaded", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const secret = "fc_super_secret_value";
    const settings = settingsWith(
      { firecrawl_api_keys: { key: "firecrawl_api_keys", value: `enc:v1:${secret}:b:c` } },
      "cloud-only",
    );
    vi.stubGlobal("fetch", vi.fn());
    const service = makeService(settings as never);

    for (let i = 0; i < 3; i++) await service.handle(makeRequest(), makeReply() as never);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(secret);
    expect(String(warn.mock.calls[0][0])).toContain("FIRECRAWL_KEYS_ENCRYPTION_KEY");
  });

  describe("audit attribution", () => {
    function makeAuthService(
      validateApiKey: ReturnType<typeof vi.fn>,
      audit: { appendAudit: ReturnType<typeof vi.fn> },
    ) {
      return new ProxyService(
        { ...config, authEnabled: true } as never,
        makeSettings() as never,
        { validateApiKey, touchApiKey: vi.fn().mockResolvedValue(undefined) } as never,
        audit as never,
        makeCredits() as never,
        makeMetrics() as never,
      );
    }

    it("records the virtual API key id on a proxied request", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const service = makeAuthService(vi.fn().mockResolvedValue({ id: "key-1" }), audit);

      await service.handle(
        makeRequest({ headers: { authorization: "Bearer fc_valid" } }),
        makeReply() as never,
      );

      expect(audit.appendAudit).toHaveBeenCalledTimes(1);
      expect(audit.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({ api_key_id: "key-1", status_code: 204 }),
      );
    });

    it("records the key id when a later stage rejects an authenticated request", async () => {
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const service = makeAuthService(vi.fn().mockResolvedValue({ id: "key-1" }), audit);
      const req = makeRequest({
        raw: { url: "/v1/agent" },
        url: "/v1/agent",
        headers: { authorization: "Bearer fc_valid" },
      });
      const reply = makeReply();

      await service.handle(req, reply as never);

      expect(reply.code).toHaveBeenCalledWith(409);
      expect(audit.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({ api_key_id: "key-1", status_code: 409 }),
      );
    });

    it("leaves the key id empty for a missing, invalid, or revoked key", async () => {
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const service = makeAuthService(vi.fn().mockResolvedValue(null), audit);

      await service.handle(makeRequest({ headers: {} }), makeReply() as never);
      await service.handle(
        makeRequest({ headers: { authorization: "Bearer fc_revoked" } }),
        makeReply() as never,
      );

      expect(audit.appendAudit).toHaveBeenCalledTimes(2);
      for (const [entry] of audit.appendAudit.mock.calls) {
        expect(entry).toMatchObject({ status_code: 401 });
        expect(entry.api_key_id).toBeUndefined();
      }
    });

    it("leaves the key id empty for admin playground and auth-disabled requests", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const validateApiKey = vi.fn();
      const authed = makeAuthService(validateApiKey, audit);

      await authed.handle(
        makeRequest({ admin: { email: "admin@example.test" } }),
        makeReply() as never,
      );
      await makeService(makeSettings(), audit).handle(makeRequest(), makeReply() as never);

      expect(validateApiKey).not.toHaveBeenCalled();
      expect(audit.appendAudit).toHaveBeenCalledTimes(2);
      for (const [entry] of audit.appendAudit.mock.calls) {
        expect(entry.api_key_id).toBeUndefined();
      }
    });
  });

  describe("per-key limits", () => {
    function makeLimitedService(
      record: Record<string, unknown>,
      hitRateLimit?: ReturnType<typeof vi.fn>,
    ) {
      const keys = {
        validateApiKey: vi.fn().mockResolvedValue({ id: "key-1", ...record }),
        touchApiKey: vi.fn().mockResolvedValue(undefined),
        hitRateLimit: hitRateLimit ?? vi.fn().mockResolvedValue(null),
        hitQuota: vi.fn().mockResolvedValue(null),
      };
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const service = new ProxyService(
        { ...config, authEnabled: true } as never,
        makeSettings() as never,
        keys as never,
        audit as never,
        makeCredits() as never,
        makeMetrics() as never,
      );
      return { service, keys, audit };
    }
    const authed = () => makeRequest({ headers: { authorization: "Bearer fc_limited" } });

    it("rejects an expired key with 401 before any upstream call, attributing the audit row", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { service, keys, audit } = makeLimitedService({
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      const reply = makeReply();

      await service.handle(authed(), reply as never);

      expect(reply.code).toHaveBeenCalledWith(401);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(keys.touchApiKey).not.toHaveBeenCalled();
      expect(audit.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          status_code: 401,
          api_key_id: "key-1",
          fallback_reason: "API key has expired",
        }),
      );
    });

    it("accepts a key whose expiry is still in the future", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const { service, keys } = makeLimitedService({
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      const reply = makeReply();

      await service.handle(authed(), reply as never);

      expect(reply.code).not.toHaveBeenCalledWith(401);
      expect(keys.touchApiKey).toHaveBeenCalledWith("key-1");
    });

    it("answers 429 with rate-limit headers when the per-key limit is exceeded", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const resetAt = Date.now() + 30_000;
      const hitRateLimit = vi
        .fn()
        .mockResolvedValue({ limit: 5, remaining: 0, resetAt, exceeded: true });
      const { service, audit } = makeLimitedService({ rate_limit_per_minute: 5 }, hitRateLimit);
      const reply = makeReply();

      await service.handle(authed(), reply as never);

      expect(hitRateLimit).toHaveBeenCalledTimes(1);
      expect(reply.code).toHaveBeenCalledWith(429);
      expect(reply.headers).toHaveBeenCalledWith(
        expect.objectContaining({
          "x-ratelimit-limit": "5",
          "x-ratelimit-remaining": "0",
          "retry-after": expect.stringMatching(/^(29|30)$/),
        }),
      );
      expect(String(reply.send.mock.calls[0][0].error)).toContain("API key rate limit exceeded");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(audit.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({ status_code: 429, api_key_id: "key-1", backend_used: "none" }),
      );
    });

    it("proxies a limited key that is within its limit", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const hitRateLimit = vi
        .fn()
        .mockResolvedValue({ limit: 5, remaining: 3, resetAt: Date.now() + 1000, exceeded: false });
      const { service } = makeLimitedService({ rate_limit_per_minute: 5 }, hitRateLimit);
      const reply = makeReply();

      await service.handle(authed(), reply as never);

      expect(reply.code).not.toHaveBeenCalledWith(429);
    });

    it("answers 429 with quota headers when the monthly quota is exhausted", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const resetAt = Date.now() + 5 * 86_400_000;
      const hitQuota = vi
        .fn()
        .mockResolvedValue({ limit: 1000, remaining: 0, resetAt, exceeded: true });
      const { service, keys, audit } = makeLimitedService({ monthly_quota: 1000 });
      keys.hitQuota = hitQuota;
      const reply = makeReply();

      await service.handle(authed(), reply as never);

      expect(hitQuota).toHaveBeenCalledTimes(1);
      expect(reply.code).toHaveBeenCalledWith(429);
      expect(reply.headers).toHaveBeenCalledWith(
        expect.objectContaining({
          "x-quota-limit": "1000",
          "x-quota-remaining": "0",
          "x-quota-reset": String(Math.ceil(resetAt / 1000)),
        }),
      );
      expect(String(reply.send.mock.calls[0][0].error)).toContain("monthly quota exceeded");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(keys.touchApiKey).not.toHaveBeenCalled();
      expect(audit.appendAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          status_code: 429,
          api_key_id: "key-1",
          fallback_reason: "API key monthly quota exceeded",
        }),
      );
    });

    it("does not spend quota on a request the per-minute limit already rejected", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const hitRateLimit = vi
        .fn()
        .mockResolvedValue({ limit: 5, remaining: 0, resetAt: Date.now() + 1000, exceeded: true });
      const { service, keys } = makeLimitedService(
        { rate_limit_per_minute: 5, monthly_quota: 1000 },
        hitRateLimit,
      );
      keys.hitQuota = vi.fn();

      await service.handle(authed(), makeReply() as never);

      expect(keys.hitQuota).not.toHaveBeenCalled();
    });

    it("proxies a key that is within its monthly quota and never counts keys without one", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const within = makeLimitedService({ monthly_quota: 1000 });
      within.keys.hitQuota = vi
        .fn()
        .mockResolvedValue({ limit: 1000, remaining: 10, resetAt: Date.now(), exceeded: false });
      const unlimited = makeLimitedService({ monthly_quota: null });
      unlimited.keys.hitQuota = vi.fn();
      const reply = makeReply();

      await within.service.handle(authed(), reply as never);
      await unlimited.service.handle(authed(), makeReply() as never);

      expect(reply.code).not.toHaveBeenCalledWith(429);
      expect(unlimited.keys.hitQuota).not.toHaveBeenCalled();
    });

    it("never consults the per-key limiter for keys without a limit", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const { service, keys } = makeLimitedService({ rate_limit_per_minute: null });

      await service.handle(authed(), makeReply() as never);

      expect(keys.hitRateLimit).not.toHaveBeenCalled();
    });
  });

  describe("request metrics", () => {
    function makeMeteredService() {
      const metrics = makeMetrics();
      const service = new ProxyService(
        config as never,
        makeSettings() as never,
        { validateApiKey: vi.fn() } as never,
        { appendAudit: vi.fn().mockResolvedValue(undefined) } as never,
        makeCredits() as never,
        metrics as never,
      );
      return { service, metrics };
    }

    it("observes a proxied request with its backend, status, fallback flag, and path", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
      const { service, metrics } = makeMeteredService();

      await service.handle(makeRequest(), makeReply() as never);

      expect(metrics.observeRequest).toHaveBeenCalledTimes(1);
      expect(metrics.observeRequest).toHaveBeenCalledWith({
        backend: "self-hosted",
        statusCode: 204,
        durationMs: expect.any(Number),
        fallbackUsed: false,
        reachedBackend: true,
        path: "/v1/test",
      });
    });

    it("does not mark a no-credit-pool 429 labelled cloud as having reached a backend", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const metrics = makeMetrics();
      const credits = makeCredits();
      credits.reserve.mockResolvedValue(null);
      const key = "fc_cloud_key_1234567890";
      const service = new ProxyService(
        config as never,
        settingsWith(
          {
            firecrawl_api_keys: {
              key: "firecrawl_api_keys",
              value: encryptSettingValue(JSON.stringify([key]), config.firecrawlKeysEncryptionKey),
            },
          },
          "cloud-only",
        ) as never,
        { validateApiKey: vi.fn() } as never,
        { appendAudit: vi.fn().mockResolvedValue(undefined) } as never,
        credits as never,
        metrics as never,
      );

      await service.handle(makeRequest(), makeReply() as never);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(metrics.observeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ backend: "cloud", statusCode: 429, reachedBackend: false }),
      );
    });

    it("observes an early rejection as backend none", async () => {
      const { service, metrics } = makeMeteredService();
      const req = makeRequest({ raw: { url: "/v1/agent" }, url: "/v1/agent" });

      await service.handle(req, makeReply() as never);

      expect(metrics.observeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "none",
          statusCode: 409,
          path: "/v1/agent",
          reachedBackend: false,
        }),
      );
    });
  });

  describe("response cache", () => {
    const CLOUD_KEY = "fc_cloud_key_1234567890";
    const SCRAPE_BODY = { url: "https://example.com", formats: ["markdown"] };
    const OK_BODY = JSON.stringify({ success: true, data: { markdown: "# hi" } });

    function scrapeRequest(overrides: Record<string, unknown> = {}, body: unknown = SCRAPE_BODY) {
      const raw = Buffer.from(JSON.stringify(body));
      return makeRequest({
        method: "POST",
        raw: { url: "/v1/scrape" },
        url: "/v1/scrape",
        headers: { authorization: "Bearer fc_client", "content-type": "application/json" },
        rawBody: raw,
        body,
        ...overrides,
      });
    }

    function makeCacheService(
      options: { keyId?: string; ttl?: number; upstream?: () => Response } = {},
    ) {
      const credits = makeCredits();
      credits.reserve.mockResolvedValue({
        key: CLOUD_KEY,
        keyId: "opaque-key-id",
        amount: 1,
        source: "local",
      });
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const metrics = makeMetrics();
      const keyId = { current: options.keyId ?? "key-1" };
      const keys = {
        validateApiKey: vi.fn().mockImplementation(async () => ({ id: keyId.current })),
        touchApiKey: vi.fn().mockResolvedValue(undefined),
      };
      const fetchMock = vi.fn().mockImplementation(
        async () =>
          options.upstream?.() ??
          new Response(OK_BODY, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      // The TTL is the `response_cache_ttl_seconds` setting (the admin Configure page).
      const ttl = { seconds: options.ttl ?? 600 };
      const settings = settingsWith(
        {
          firecrawl_api_keys: {
            key: "firecrawl_api_keys",
            value: encryptSettingValue(
              JSON.stringify([CLOUD_KEY]),
              config.firecrawlKeysEncryptionKey,
            ),
          },
        },
        "cloud-only",
      );
      const base = settings.getSettings.getMockImplementation()!;
      settings.getSettings.mockImplementation(async (...args: unknown[]) => ({
        ...(await base(...args)),
        response_cache_ttl_seconds: {
          key: "response_cache_ttl_seconds",
          value: String(ttl.seconds),
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      }));
      const service = new ProxyService(
        {
          ...config,
          authEnabled: true,
          responseCacheMaxBytes: 10 * 1024 * 1024,
        } as never,
        settings as never,
        keys as never,
        audit as never,
        credits as never,
        metrics as never,
      );
      return { service, fetchMock, credits, audit, metrics, keyId, ttl };
    }

    async function stored(metrics: ReturnType<typeof makeMetrics>, count = 1) {
      await vi.waitFor(() => {
        const stores = metrics.recordResponseCache.mock.calls.filter(([r]) => r === "store");
        expect(stores).toHaveLength(count);
      });
    }

    it("stores a successful Cloud scrape and serves the repeat without upstream or credits", async () => {
      const { service, fetchMock, credits, audit, metrics } = makeCacheService();

      await service.handle(scrapeRequest(), makeReply() as never);
      await stored(metrics);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(credits.reserve).toHaveBeenCalledTimes(1);

      const reply = makeReply();
      await service.handle(scrapeRequest(), reply as never);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(credits.reserve).toHaveBeenCalledTimes(1);
      expect(reply.code).toHaveBeenCalledWith(200);
      expect(reply.headers).toHaveBeenCalledWith(
        expect.objectContaining({
          "x-hybrid-firecrawl-cache": "hit",
          "x-hybrid-firecrawl-backend": "cache",
          "content-type": "application/json",
        }),
      );
      expect(String(reply.send.mock.calls[0][0])).toBe(OK_BODY);
      expect(audit.appendAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ backend_used: "cache", status_code: 200, api_key_id: "key-1" }),
      );
      expect(metrics.observeRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ backend: "cache", reachedBackend: false, statusCode: 200 }),
      );
      expect(metrics.recordResponseCache).toHaveBeenCalledWith("hit");
    });

    it("streams the first response to the client unchanged while caching it", async () => {
      const { service, metrics } = makeCacheService();
      const chunks: Buffer[] = [];
      const reply = makeReply();
      // The default test sink discards writes; collect them through a real pipe instead.
      const { PassThrough } = await import("node:stream");
      const sink = new PassThrough();
      sink.on("data", (chunk: Buffer) => chunks.push(chunk));
      (reply as { raw: unknown }).raw = Object.assign(sink, { writeHead: vi.fn() });

      await service.handle(scrapeRequest(), reply as never);
      await stored(metrics);

      expect(Buffer.concat(chunks).toString("utf8")).toBe(OK_BODY);
      expect(metrics.recordResponseCache).toHaveBeenCalledWith("miss");
    });

    it("terminates both branches and releases memory when the client disconnects mid-stream", async () => {
      const { Writable } = await import("node:stream");
      let produced = 0;
      let cancelled = false;
      const chunk = new Uint8Array(64 * 1024).fill(97);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          // More than the 2 MiB cache cap, produced lazily so cancellation is observable.
          if (produced >= 3 * 1024 * 1024) return controller.close();
          produced += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      });
      const { service, metrics } = makeCacheService({
        upstream: () =>
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      });
      const reply = makeReply();
      // A client that hangs up after receiving the first chunk.
      (reply as { raw: unknown }).raw = Object.assign(
        new Writable({
          write(_chunk, _encoding, callback) {
            callback();
            this.destroy();
          },
        }),
        { writeHead: vi.fn() },
      );

      await service.handle(scrapeRequest(), reply as never);

      await vi.waitFor(() => expect(cancelled).toBe(true));
      expect(produced).toBeLessThan(3 * 1024 * 1024);
      expect(metrics.recordResponseCache).not.toHaveBeenCalledWith("store");
    });

    it("abandons a collector whose upstream stalls instead of holding the buffer forever", async () => {
      vi.useFakeTimers();
      let cancelled = false;
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"success":'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const { service, metrics } = makeCacheService();
      const collect = (
        service as unknown as {
          collectForCache(k: string, s: ReadableStream<Uint8Array>, t: string): Promise<void>;
        }
      ).collectForCache.bind(service);

      const done = collect("key", stalled, "application/json");
      await vi.advanceTimersByTimeAsync(config.requestTimeoutMs);
      await done;

      expect(cancelled).toBe(true);
      expect(metrics.recordResponseCache).not.toHaveBeenCalledWith("store");
    });

    it("never shares entries between virtual API keys", async () => {
      const { service, fetchMock, metrics, keyId } = makeCacheService();
      await service.handle(scrapeRequest(), makeReply() as never);
      await stored(metrics);

      keyId.current = "key-2";
      await service.handle(scrapeRequest(), makeReply() as never);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache non-success bodies, upstream errors, or oversized responses", async () => {
      const failures = [
        () =>
          new Response(JSON.stringify({ success: false, error: "nope" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        () =>
          new Response(JSON.stringify({ success: true }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        () =>
          new Response("x".repeat(2 * 1024 * 1024 + 10), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        () => new Response(OK_BODY, { status: 200, headers: { "content-type": "text/html" } }),
      ];
      for (const upstream of failures) {
        const { service, fetchMock, metrics } = makeCacheService({ upstream });

        await service.handle(scrapeRequest(), makeReply() as never);
        // Give the background collector a chance to (not) store.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await service.handle(scrapeRequest(), makeReply() as never);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(metrics.recordResponseCache).not.toHaveBeenCalledWith("store");
      }
    });

    it.each([
      ["a sensitive header", { headers: { authorization: "Bearer fc_client", cookie: "sid=1" } }],
      [
        "Cache-Control: no-cache",
        { headers: { authorization: "Bearer fc_client", "cache-control": "no-cache" } },
      ],
    ])("bypasses the cache for %s", async (_name, overrides) => {
      const { service, fetchMock, metrics } = makeCacheService();
      await service.handle(scrapeRequest(), makeReply() as never);
      await stored(metrics);

      await service.handle(scrapeRequest(overrides), makeReply() as never);

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("honours the request's own maxAge: 0 and storeInCache: false", async () => {
      const { service, fetchMock, metrics } = makeCacheService();
      await service.handle(scrapeRequest(), makeReply() as never);
      await stored(metrics);

      await service.handle(scrapeRequest({}, { ...SCRAPE_BODY, maxAge: 0 }), makeReply() as never);
      await service.handle(
        scrapeRequest({}, { ...SCRAPE_BODY, storeInCache: false }),
        makeReply() as never,
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("applies a TTL change from the Configure setting on the next request", async () => {
      const { service, fetchMock, metrics, ttl } = makeCacheService();
      await service.handle(scrapeRequest(), makeReply() as never);
      await stored(metrics);
      await service.handle(scrapeRequest(), makeReply() as never);
      expect(fetchMock).toHaveBeenCalledTimes(1); // served from the cache

      ttl.seconds = 0; // the admin switches the cache off
      await service.handle(scrapeRequest(), makeReply() as never);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Switching it back on must not resurrect what was cached before it was disabled.
      ttl.seconds = 600;
      await service.handle(scrapeRequest(), makeReply() as never);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("is off unless a TTL is configured", async () => {
      const { service, fetchMock, metrics } = makeCacheService({ ttl: 0 });

      await service.handle(scrapeRequest(), makeReply() as never);
      await service.handle(scrapeRequest(), makeReply() as never);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(metrics.recordResponseCache).not.toHaveBeenCalled();
    });
  });

  describe("self-hosted circuit breaker", () => {
    const CLOUD_KEY = "fc_cloud_key_1234567890";
    const THRESHOLD = config.selfHostedBreakerFailureThreshold;

    function makeBreakerService(
      routeMode: string,
      options: { withCloudKey?: boolean; breakerConfig?: Record<string, unknown> } = {},
    ) {
      const records: Record<string, { key: string; value: string }> = {};
      if (options.withCloudKey)
        records.firecrawl_api_keys = {
          key: "firecrawl_api_keys",
          value: encryptSettingValue(
            JSON.stringify([CLOUD_KEY]),
            config.firecrawlKeysEncryptionKey,
          ),
        };
      const credits = makeCredits();
      credits.reserve.mockResolvedValue({
        key: CLOUD_KEY,
        keyId: "opaque-key-id",
        amount: 1,
        source: "local",
      });
      const audit = { appendAudit: vi.fn().mockResolvedValue(undefined) };
      const metrics = makeMetrics();
      const service = new ProxyService(
        { ...config, ...options.breakerConfig } as never,
        settingsWith(records, routeMode) as never,
        { validateApiKey: vi.fn() } as never,
        audit as never,
        credits as never,
        metrics as never,
      );
      return { service, credits, audit, metrics };
    }

    function urlsOf(fetchMock: ReturnType<typeof vi.fn>): string[] {
      return fetchMock.mock.calls.map(([url]) => String(url));
    }

    it("stops calling self-hosted after consecutive connection failures and fails fast with 502", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);
      const { service, metrics } = makeBreakerService("self-hosted-only");

      for (let i = 0; i < THRESHOLD; i += 1)
        await service.handle(makeRequest(), makeReply() as never);
      expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD);
      expect(metrics.recordCircuitTransition).toHaveBeenCalledWith("open");

      const reply = makeReply();
      await service.handle(makeRequest(), reply as never);

      expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD);
      expect(reply.code).toHaveBeenCalledWith(502);
      expect(String(reply.send.mock.calls[0][0])).toContain("circuit open");
      expect(metrics.recordCircuitRejected).toHaveBeenCalledTimes(1);
      // A short-circuited request never reached self-hosted, so it must not feed the
      // backend-health fallback window even though it is labelled self-hosted.
      expect(metrics.observeRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          backend: "self-hosted",
          statusCode: 502,
          reachedBackend: false,
        }),
      );
      expect(metrics.observeRequest).toHaveBeenCalledWith(
        expect.objectContaining({ backend: "self-hosted", reachedBackend: true }),
      );
    });

    it.each([502, 503, 504])("counts a %i from self-hosted as unavailable", async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("down", { status }));
      vi.stubGlobal("fetch", fetchMock);
      const { service } = makeBreakerService("self-hosted-only");

      for (let i = 0; i < THRESHOLD + 2; i += 1)
        await service.handle(makeRequest(), makeReply() as never);

      expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD);
    });

    it("does not count request-specific failures (generic 500, unsupported-feature 4xx)", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => new Response("boom", { status: 500 }));
      vi.stubGlobal("fetch", fetchMock);
      const { service, metrics } = makeBreakerService("self-hosted-only");

      for (let i = 0; i < THRESHOLD + 3; i += 1)
        await service.handle(makeRequest(), makeReply() as never);
      fetchMock.mockImplementation(
        async () => new Response("actions are not supported", { status: 400 }),
      );
      for (let i = 0; i < THRESHOLD + 3; i += 1)
        await service.handle(makeRequest(), makeReply() as never);

      expect(fetchMock).toHaveBeenCalledTimes((THRESHOLD + 3) * 2);
      expect(metrics.recordCircuitTransition).not.toHaveBeenCalled();
    });

    it("recovers through a half-open probe once the cooldown elapses", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);
      const { service, metrics } = makeBreakerService("self-hosted-only");
      for (let i = 0; i < THRESHOLD; i += 1)
        await service.handle(makeRequest(), makeReply() as never);

      vi.advanceTimersByTime(config.selfHostedBreakerCooldownMs);
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      const reply = makeReply();
      await service.handle(makeRequest(), reply as never);

      expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD + 1);
      expect(metrics.recordCircuitTransition.mock.calls.map(([state]) => state)).toEqual([
        "open",
        "half-open",
        "closed",
      ]);
      await service.handle(makeRequest(), makeReply() as never);
      expect(fetchMock).toHaveBeenCalledTimes(THRESHOLD + 2);
    });

    it("lets the existing fallback policy send traffic to Cloud while the circuit is open", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).startsWith("https://self.test")) throw new Error("connect ECONNREFUSED");
        return new Response("ok", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { service, audit } = makeBreakerService("self-hosted-first", { withCloudKey: true });
      for (let i = 0; i < THRESHOLD; i += 1)
        await service.handle(makeRequest(), makeReply() as never);
      fetchMock.mockClear();

      const reply = makeReply();
      await service.handle(makeRequest(), reply as never);

      expect(urlsOf(fetchMock)).toEqual(["https://cloud.test/v1/test"]);
      const entry = audit.appendAudit.mock.calls.at(-1)?.[0];
      expect(entry).toMatchObject({ backend_used: "cloud", fallback_used: true });
      expect(entry.fallback_reason).toContain("circuit open");
    });

    it("still counts a request whose Cloud attempt was real when the final result is short-circuited", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);
      const { service, credits, metrics } = makeBreakerService("cloud-first", {
        withCloudKey: true,
      });
      // One real Cloud reservation, then the pool is exhausted so self-hosted is the last resort.
      credits.reserve
        .mockResolvedValueOnce({
          key: CLOUD_KEY,
          keyId: "opaque-key-id",
          amount: 1,
          source: "local",
        })
        .mockResolvedValue(null);
      const breaker = (service as unknown as { selfHostedBreaker: CircuitBreaker })
        .selfHostedBreaker;
      for (let i = 0; i < THRESHOLD; i += 1)
        await breaker.execute(
          async () => ({ kind: "network-error" }),
          isSelfHostedUnavailable,
          () => ({ kind: "network-error" }),
        );
      expect(breaker.currentState).toBe("open");
      metrics.observeRequest.mockClear();
      const reply = makeReply();

      await service.handle(makeRequest(), reply as never);

      expect(urlsOf(fetchMock)).toEqual(["https://cloud.test/v1/test"]);
      expect(reply.code).toHaveBeenCalledWith(502);
      expect(metrics.observeRequest).toHaveBeenCalledTimes(1);
      expect(metrics.observeRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "self-hosted",
          statusCode: 502,
          fallbackUsed: true,
          reachedBackend: true,
        }),
      );
    });

    it("never falls back to Cloud for a sensitive request while the circuit is open", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).startsWith("https://self.test")) throw new Error("connect ECONNREFUSED");
        return new Response("ok", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { service, credits } = makeBreakerService("self-hosted-first", { withCloudKey: true });
      const sensitive = () => makeRequest({ headers: { cookie: "session=private" } });
      for (let i = 0; i < THRESHOLD; i += 1)
        await service.handle(sensitive(), makeReply() as never);
      fetchMock.mockClear();

      const reply = makeReply();
      await service.handle(sensitive(), reply as never);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(credits.reserve).not.toHaveBeenCalled();
      expect(reply.code).toHaveBeenCalledWith(502);
    });

    it("does not trip when the threshold is 0", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);
      const { service, metrics } = makeBreakerService("self-hosted-only", {
        breakerConfig: { selfHostedBreakerFailureThreshold: 0 },
      });

      for (let i = 0; i < 10; i += 1) await service.handle(makeRequest(), makeReply() as never);

      expect(fetchMock).toHaveBeenCalledTimes(10);
      expect(metrics.recordCircuitTransition).not.toHaveBeenCalled();
    });
  });
});
