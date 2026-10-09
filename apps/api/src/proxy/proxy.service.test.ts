import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestWithContext } from "../common/types";
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
    for (let i = 0; i < 10 && events.length < 2; i++) await Promise.resolve();

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
    for (let i = 0; i < 10 && events.length < 1; i++) await Promise.resolve();

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
    for (let i = 0; i < 10 && events.length < 1; i++) await Promise.resolve();

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
});
