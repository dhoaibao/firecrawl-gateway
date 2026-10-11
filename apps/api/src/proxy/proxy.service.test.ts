import { Writable } from "node:stream";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestWithContext } from "../common/types";
import * as cryptoModule from "../common/crypto";
import { encryptSettingValue } from "../common/crypto";
import { ProxyService } from "./proxy.service";

const config = {
  cloudBaseUrl: "https://cloud.test",
  selfHostedBaseUrl: "https://self.test",
  requestTimeoutMs: 1_000,
  maxBodyBytes: 1_024 * 1_024,
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
    );

    const handled = service.handle(
      makeRequest({ headers: { authorization: "Bearer gw_key" } }),
      makeReply() as never,
    );
    await Promise.resolve();

    expect(settings.getSettings).toHaveBeenCalledTimes(1);
    expect(settings.getSettings).toHaveBeenCalledWith(["default_route_mode", "firecrawl_api_keys"]);
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
});
