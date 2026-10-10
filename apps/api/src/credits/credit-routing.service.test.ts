import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CreditRoutingService,
  extractCreditsUsed,
  observeCreditsUsedStream,
} from "./credit-routing.service";

const config = {
  cloudBaseUrl: "https://cloud.test",
  redisUrl: "redis://localhost:6379",
  firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

function makeLedger(overrides: Record<string, unknown> = {}) {
  return {
    reserve: vi.fn().mockResolvedValue({ kind: "unavailable" }),
    capture: vi.fn().mockResolvedValue({ available: false, sequence: 0 }),
    reconcile: vi.fn().mockResolvedValue(true),
    settle: vi.fn().mockResolvedValue(true),
    settleActualUsage: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CreditRoutingService", () => {
  it("uses atomic Redis selection when available and passes only opaque key IDs", async () => {
    const ledger = makeLedger({
      reserve: vi.fn().mockResolvedValue({
        kind: "reserved",
        index: 1,
        sequence: 7,
        reservationKey: "opaque-reservation",
      }),
    });
    const service = new CreditRoutingService(config as never, ledger as never);
    const keys = ["fc_first_secret_key", "fc_second_secret_key"];

    const reservation = await service.reserve(keys, 1);

    expect(reservation).toEqual({
      key: keys[1],
      keyId: expect.any(String),
      amount: 1,
      source: "redis",
      reservationKey: "opaque-reservation",
    });
    expect(reservation?.keyId).not.toBe(keys[1]);
    expect(ledger.reserve).toHaveBeenCalledWith(
      keys.map((key) => service.keyId(key)),
      1,
    );
  });

  it("returns a stable opaque key ID per API key", () => {
    const service = new CreditRoutingService(config as never, makeLedger() as never);

    const id = service.keyId("fc_first_secret_key");

    expect(service.keyId("fc_first_secret_key")).toBe(id);
    expect(service.keyId("fc_second_secret_key")).not.toBe(id);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain("fc_first_secret_key");
  });

  it("falls back to random local selection among ties without fetching credit usage", async () => {
    const ledger = makeLedger();
    const service = new CreditRoutingService(config as never, ledger as never);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const keys = ["fc_first_secret_key", "fc_second_secret_key"];
    const random = vi.spyOn(Math, "random");

    random.mockReturnValueOnce(0);
    const first = await service.reserve(keys, 1);
    random.mockReturnValueOnce(0.99);
    const second = await service.reserve(keys, 1);

    expect(first?.key).toBe(keys[0]);
    expect(second?.key).toBe(keys[1]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ledger.reserve).toHaveBeenCalledWith(
      keys.map((key) => service.keyId(key)),
      1,
    );
  });

  it("treats 402 as a disabled pool and 429 as a temporary cooldown", async () => {
    const ledger = makeLedger();
    const service = new CreditRoutingService(config as never, ledger as never);
    const keys = ["fc_first_secret_key", "fc_second_secret_key"];

    vi.spyOn(Math, "random").mockReturnValue(0);
    const first = await service.reserve(keys, 1);
    expect(first?.key).toBe(keys[0]);
    await service.recordResponse(first!, 402);
    const second = await service.reserve(keys, 1);
    expect(second?.key).toBe(keys[1]);

    await service.recordResponse(second!, 429);
    expect(await service.reserve(keys, 1)).toBeNull();

    expect(ledger.settle).not.toHaveBeenCalled();
  });

  it("keeps locally disabled and cooled-down keys out of recovered Redis reservations", async () => {
    vi.useFakeTimers();
    const ledger = makeLedger();
    const service = new CreditRoutingService(config as never, ledger as never);
    const keys = ["fc_first_secret_key", "fc_second_secret_key", "fc_third_secret_key"];

    const random = vi.spyOn(Math, "random");
    random.mockReturnValueOnce(0);
    const disabled = await service.reserve(keys, 1);
    await service.recordResponse(disabled!, 402);
    random.mockReturnValueOnce(0.99);
    const cooledDown = await service.reserve(keys, 1);
    await service.recordResponse(cooledDown!, 429);

    ledger.reserve.mockResolvedValue({
      kind: "reserved",
      index: 0,
      sequence: 3,
      reservationKey: "opaque-recovered-reservation",
    });
    vi.advanceTimersByTime(5_001);
    const recovered = await service.reserve(keys, 1);

    expect(recovered?.key).toBe(keys[1]);
    expect(ledger.reserve).toHaveBeenLastCalledWith([service.keyId(keys[1])], 1);
  });

  it("settles Redis reservations differently for 402 and 429", async () => {
    const ledger = makeLedger({
      reserve: vi.fn().mockResolvedValue({
        kind: "reserved",
        index: 0,
        sequence: 1,
        reservationKey: "opaque-reservation",
      }),
    });
    const service = new CreditRoutingService(config as never, ledger as never);
    const reservation = await service.reserve(["fc_secret_key"], 1);

    await service.recordResponse(reservation!, 402);
    await service.recordResponse(
      { ...reservation!, keyId: "another-opaque-id", reservationKey: "opaque-reservation-2" },
      429,
    );

    expect(ledger.settle).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "opaque-reservation",
      "disabled",
    );
    expect(ledger.settle).toHaveBeenNthCalledWith(
      2,
      "another-opaque-id",
      "opaque-reservation-2",
      "cooldown",
      expect.any(Number),
    );
  });

  it("adjusts Redis reservations to zero and higher actual usage", async () => {
    const ledger = makeLedger({
      reserve: vi.fn().mockResolvedValue({
        kind: "reserved",
        index: 0,
        sequence: 1,
        reservationKey: "opaque-reservation",
      }),
    });
    const service = new CreditRoutingService(config as never, ledger as never);
    const reservation = await service.reserve(["fc_secret_key"], 1);

    await service.recordResponse(reservation!, 200, 0);
    await service.recordResponse(
      { ...reservation!, reservationKey: "opaque-reservation-2" },
      201,
      4,
    );

    expect(ledger.settleActualUsage).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "opaque-reservation",
      0,
    );
    expect(ledger.settleActualUsage).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "opaque-reservation-2",
      4,
    );
  });

  it("extracts only direct metadata creditsUsed values", () => {
    expect(
      extractCreditsUsed(
        new TextEncoder().encode('{"data":{"creditsUsed":2},"metadata":{"creditsUsed":7}}'),
      ),
    ).toBe(7);
    expect(
      extractCreditsUsed(
        new TextEncoder().encode('{"metadata":{"nested":{"creditsUsed":2},"creditsUsed":7}}'),
      ),
    ).toBe(7);
    expect(
      extractCreditsUsed(
        new TextEncoder().encode(
          '{"message":"\\"creditsUsed\\": 99","metadata":{"creditsUsed":3}}',
        ),
      ),
    ).toBe(3);
    expect(
      extractCreditsUsed(new TextEncoder().encode('{"metadata":{"creditsUsed":-1}}')),
    ).toBeNull();
    expect(
      extractCreditsUsed(new TextEncoder().encode('{"metadata":{"creditsUsed":1.5}}')),
    ).toBeNull();
    expect(extractCreditsUsed(new TextEncoder().encode('{"metadata":{"other":2}}'))).toBeNull();
    expect(
      extractCreditsUsed(new TextEncoder().encode('{"metadata":{"credits\\uUsed":2}}')),
    ).toBeNull();
  });

  it("observes streamed creditsUsed across chunks without awaiting settlement", async () => {
    let settleStarted = false;
    let resolveSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      resolveSettlement = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"metadata":{"cred'));
        controller.enqueue(new TextEncoder().encode('itsUsed": 7}}'));
        controller.close();
      },
    });
    const observed = observeCreditsUsedStream(source, async (creditsUsed) => {
      settleStarted = creditsUsed === 7;
      await settlement;
    });

    const body = await new Response(observed).text();
    expect(body).toBe('{"metadata":{"creditsUsed": 7}}');
    expect(settleStarted).toBe(true);
    resolveSettlement();
  });

  async function observeChunks(chunks: string[]): Promise<number | null> {
    let found: number | null = null;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    await new Response(
      observeCreditsUsedStream(source, (creditsUsed) => {
        found = creditsUsed;
      }),
    ).text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return found;
  }

  it("finds creditsUsed after strings with escapes, split at any byte boundary", async () => {
    const documents = [
      '{"message":"a \\"quoted\\" \\\\ value","metadata":{"creditsUsed":4}}',
      '{"a":"\\\\","metadata":{"creditsUsed":5}}',
      '{"data":{"creditsUsed":2},"metadata":{"creditsUsed":8}}',
      '{"metadata":{"credits\\uUsed":2}}',
    ];
    for (const document of documents) {
      const whole = extractCreditsUsed(new TextEncoder().encode(document));
      const bytewise = await observeChunks([...document]);
      expect(bytewise).toBe(whole);
    }
    expect(extractCreditsUsed(new TextEncoder().encode(documents[0]))).toBe(4);
    expect(extractCreditsUsed(new TextEncoder().encode(documents[1]))).toBe(5);
    expect(extractCreditsUsed(new TextEncoder().encode(documents[2]))).toBe(8);
  });

  it("scans long string values and large bodies without a match", async () => {
    const long = "x".repeat(200_000);
    expect(
      extractCreditsUsed(
        new TextEncoder().encode(`{"markdown":"${long}","metadata":{"creditsUsed":9}}`),
      ),
    ).toBe(9);
    expect(
      extractCreditsUsed(
        new TextEncoder().encode(`{"markdown":"${long}","other":"${long}","data":[1,2,3]}`),
      ),
    ).toBeNull();
    expect(
      await observeChunks([`{"markdown":"${long}`, long, `","metadata":{"creditsUsed":6}}`]),
    ).toBe(6);
  });

  it("keeps scanning linear on escape-heavy strings by never re-searching a consumed suffix", () => {
    class CountingBytes extends Uint8Array {
      scanned = 0;
      override indexOf(value: number, from = 0): number {
        const found = super.indexOf(value, from);
        this.scanned += (found === -1 ? this.length : found) - from;
        return found;
      }
    }
    const text = `{"markdown":"${"\\\\".repeat(20_000)}","metadata":{"creditsUsed":3}}`;
    const bytes = new CountingBytes(new TextEncoder().encode(text));

    expect(extractCreditsUsed(bytes)).toBe(3);
    // One pass each for quotes and backslashes; a re-scan per escape would be ~n^2/2.
    expect(bytes.scanned).toBeLessThanOrEqual(2 * bytes.length);
  });

  it("reconciles successful authoritative refreshes but retains state after failed refreshes", async () => {
    vi.useFakeTimers();
    const ledger = makeLedger({
      capture: vi.fn().mockResolvedValue({ available: true, sequence: 12 }),
    });
    const service = new CreditRoutingService(config as never, ledger as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { remainingCredits: 425, planCredits: 1000 } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("upstream unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const key = "fc_refresh_secret_key";

    await expect(service.refreshCreditUsage(key)).resolves.toMatchObject({ remainingCredits: 425 });
    expect(ledger.reconcile).toHaveBeenCalledWith(service.keyId(key), 425, 12, 0);
    vi.advanceTimersByTime(30_001);

    await expect(service.refreshCreditUsage(key)).resolves.toMatchObject({
      error: "HTTP 503: upstream unavailable",
    });
    expect(ledger.reconcile).toHaveBeenCalledTimes(1);
  });

  it("prefers the soonest renewal day, then most credits, in local fallback and passes renewal to Redis", async () => {
    const ledger = makeLedger({
      capture: vi.fn().mockResolvedValue({ available: true, sequence: 1 }),
    });
    const service = new CreditRoutingService(config as never, ledger as never);
    const usage: Record<string, { remainingCredits: number; billingPeriodEnd: string }> = {
      fc_late_many: { remainingCredits: 900, billingPeriodEnd: "2026-09-20T01:00:00Z" },
      fc_soon_few: { remainingCredits: 100, billingPeriodEnd: "2026-09-05T23:00:00Z" },
      fc_soon_many: { remainingCredits: 500, billingPeriodEnd: "2026-09-05T01:00:00Z" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { headers: { authorization: string } }) => {
        const key = init.headers.authorization.replace("Bearer ", "");
        return new Response(JSON.stringify({ data: usage[key] }), { status: 200 });
      }),
    );
    const keys = Object.keys(usage);
    await service.refreshCreditUsageForKeys(keys);
    expect(ledger.reconcile).toHaveBeenCalledWith(
      service.keyId("fc_soon_few"),
      100,
      1,
      Date.parse("2026-09-05T23:00:00Z"),
    );

    expect((await service.reserve(keys, 1))?.key).toBe("fc_soon_many");
  });

  it("coalesces concurrent refreshes and caches only successful responses", async () => {
    const ledger = makeLedger();
    const service = new CreditRoutingService(config as never, ledger as never);
    let resolveFetch!: (response: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal("fetch", fetchMock);
    const key = "fc_refresh_secret_key";

    const promise1 = service.refreshCreditUsage(key);
    const promise2 = service.refreshCreditUsage(key);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(
      new Response(JSON.stringify({ data: { remainingCredits: 100 } }), { status: 200 }),
    );
    await Promise.all([promise1, promise2]);
    await service.refreshCreditUsage(key);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
