import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { RateLimitMiddleware } from "./rate-limit.middleware";

type QueryRawMock = ReturnType<typeof vi.fn>;

const FOUR_TWENTY_NINE_BODY = {
  success: false,
  error: "Too many requests. Please try again later.",
};

function makeRequest(url = "/v1/scrape", ip = "203.0.113.10"): FastifyRequest {
  return { url, ip, raw: { socket: { remoteAddress: undefined } } } as unknown as FastifyRequest;
}

function makeReply() {
  const headers: Record<string, string> = {};
  const reply = {
    header: vi.fn((name: string, value: unknown) => {
      headers[name] = String(value);
      return reply;
    }),
    code: vi.fn(() => reply),
    send: vi.fn(() => reply),
  };
  return { reply: reply as unknown as FastifyReply, headers, code: reply.code, send: reply.send };
}
function createMiddleware(
  queryRaw: QueryRawMock,
  metrics: { recordRateLimited: () => void } = { recordRateLimited: vi.fn() },
): RateLimitMiddleware {
  const prisma = { $queryRaw: queryRaw };
  return new RateLimitMiddleware(prisma as never, {} as never, metrics as never);
}

/** The middleware's counter state, which these tests assert on directly. */
function bucketsOf(middleware: RateLimitMiddleware) {
  return (
    middleware as unknown as {
      counter: { buckets: Map<string, { syncedCount: number; pendingDelta: number }> };
    }
  ).counter.buckets;
}

/** Extracts the delta substituted into VALUES from a captured Prisma.sql call. */
function deltaOf(call: unknown[]): number {
  const sql = call[0] as unknown as { values: unknown[] };
  return Number(sql.values[1]);
}

describe("RateLimitMiddleware (hybrid in-memory counting)", () => {
  let authoritativeCount: number;
  let queryRaw: QueryRawMock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
    authoritativeCount = 0;
    queryRaw = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve([{ count: authoritativeCount, reset_at: new Date(Date.now() + 60_000) }]),
      );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function makeRequestThrough(middleware: RateLimitMiddleware, ip?: string, url?: string) {
    const reply = makeReply();
    const next = vi.fn();
    await middleware.use(
      url !== undefined ? makeRequest(url, ip) : makeRequest(undefined, ip),
      reply.reply,
      next,
    );
    return { reply, next };
  }

  it("issues exactly one query for many requests from one IP inside a flush interval", async () => {
    const middleware = createMiddleware(queryRaw);

    for (let i = 0; i < 50; i += 1) {
      const { next } = await makeRequestThrough(middleware);
      expect(next).toHaveBeenCalled();
    }

    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("flushes the accumulated delta after the interval elapses", async () => {
    const middleware = createMiddleware(queryRaw);

    await makeRequestThrough(middleware); // flushes delta 1 immediately (first sight)
    for (let i = 0; i < 4; i += 1) await makeRequestThrough(middleware); // accumulate locally
    expect(queryRaw).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    await makeRequestThrough(middleware); // pending becomes 5, then flushes

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(deltaOf(queryRaw.mock.calls[1])).toBe(5);
  });

  it("respects the authoritative count: boundary request passes and the next gets the exact 429 body", async () => {
    authoritativeCount = 299;
    const middleware = createMiddleware(queryRaw);

    // Flush returns 299; effective = 299 -> passes.
    const first = await makeRequestThrough(middleware);
    expect(first.next).toHaveBeenCalled();
    expect(first.reply.code).not.toHaveBeenCalled();

    // effective = 300 -> still passes (block is strictly above the limit).
    const second = await makeRequestThrough(middleware);
    expect(second.next).toHaveBeenCalled();
    expect(second.reply.code).not.toHaveBeenCalled();

    // effective = 301 -> blocked with the exact contract body.
    const third = await makeRequestThrough(middleware);
    expect(third.next).not.toHaveBeenCalled();
    expect(third.reply.code).toHaveBeenCalledWith(429);
    expect(third.reply.send).toHaveBeenCalledWith(FOUR_TWENTY_NINE_BODY);
  });

  it.each(["/health", "/ready", "/admin/api/metrics", "/admin/api/metrics?x=1"])(
    "does not touch Postgres or count requests for %s",
    async (url) => {
      authoritativeCount = 10_000; // would block any counted request
      const metrics = { recordRateLimited: vi.fn() };
      const middleware = createMiddleware(queryRaw, metrics);

      for (let i = 0; i < 5; i += 1) {
        const { next, reply } = await makeRequestThrough(middleware, undefined, url);
        expect(next).toHaveBeenCalled();
        expect(reply.code).not.toHaveBeenCalled();
      }

      expect(queryRaw).not.toHaveBeenCalled();
      expect(metrics.recordRateLimited).not.toHaveBeenCalled();
    },
  );

  it("still rate limits ordinary admin API paths", async () => {
    authoritativeCount = 10_000;
    const middleware = createMiddleware(queryRaw);

    const { next, reply } = await makeRequestThrough(middleware, undefined, "/admin/api/logs");

    expect(next).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(429);
  });

  it("counts only rejected requests in the rate-limit metric", async () => {
    authoritativeCount = 299;
    const metrics = { recordRateLimited: vi.fn() };
    const middleware = createMiddleware(queryRaw, metrics);

    await makeRequestThrough(middleware); // 299 -> passes
    await makeRequestThrough(middleware); // 300 -> passes
    expect(metrics.recordRateLimited).not.toHaveBeenCalled();

    await makeRequestThrough(middleware); // 301 -> blocked
    expect(metrics.recordRateLimited).toHaveBeenCalledTimes(1);
  });

  it("clears counters once resetAt passes", async () => {
    authoritativeCount = 299;
    const middleware = createMiddleware(queryRaw);

    await makeRequestThrough(middleware); // syncs to 299
    for (let i = 0; i < 3; i += 1) await makeRequestThrough(middleware); // effective reaches 302 -> blocked

    authoritativeCount = 0;
    vi.advanceTimersByTime(61_000); // past the window

    const after = await makeRequestThrough(middleware);
    expect(after.next).toHaveBeenCalled();
    expect(after.reply.code).not.toHaveBeenCalled();
    expect(after.reply.headers["X-RateLimit-Remaining"]).toBe("300");
    const bucket = bucketsOf(middleware).get("203.0.113.10");
    expect(bucket?.syncedCount).toBe(0);
    expect(bucket?.pendingDelta).toBe(0);
  });

  it("bounds the bucket map at the cap across more distinct IPs than the cap", async () => {
    const middleware = createMiddleware(queryRaw);

    for (let i = 0; i < 10_010; i += 1) {
      const ip = `10.0.${Math.floor(i / 256) % 256}.${i % 256}`;
      await makeRequestThrough(middleware, ip);
    }

    expect(bucketsOf(middleware).size).toBe(10_000);
  });

  it("does not throw on query failure, proceeds, and restores the delta instead of losing it", async () => {
    queryRaw.mockRejectedValueOnce(new Error("database down"));
    const middleware = createMiddleware(queryRaw);

    const first = await makeRequestThrough(middleware);
    expect(first.next).toHaveBeenCalled();

    // The failed flush's delta was restored.
    expect(bucketsOf(middleware).get("203.0.113.10")?.pendingDelta).toBe(1);

    // Counting keeps enforcing locally with no further queries inside the interval.
    const second = await makeRequestThrough(middleware);
    expect(second.next).toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(bucketsOf(middleware).get("203.0.113.10")?.pendingDelta).toBe(2);
  });

  it("coalesces concurrent requests for one key into a single flush without lost increments", async () => {
    let sentDelta = 0;
    queryRaw.mockImplementation((sql: unknown) => {
      sentDelta = Number((sql as { values: unknown[] }).values[1]);
      return Promise.resolve([{ count: sentDelta, reset_at: new Date(Date.now() + 60_000) }]);
    });
    const middleware = createMiddleware(queryRaw);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => {
        const reply = makeReply();
        const next = vi.fn();
        return middleware.use(makeRequest(), reply.reply, next).then(() => ({ reply, next }));
      }),
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(sentDelta).toBe(1);

    // The leader flushed its delta of 1; the four later arrivals survive
    // in pendingDelta. Total accounted: 1 synced + 4 pending = 5.
    const bucket = bucketsOf(middleware).get("203.0.113.10");
    expect(bucket?.syncedCount).toBe(1);
    expect(bucket?.pendingDelta).toBe(4);

    for (const result of results) {
      expect(result.next).toHaveBeenCalled();
      expect(result.reply.code).not.toHaveBeenCalled();
    }
  });

  it("skips /health and /ready entirely with no DB query", async () => {
    const middleware = createMiddleware(queryRaw);

    for (const url of ["/health", "/ready"]) {
      const { reply, next } = await makeRequestThrough(middleware, "203.0.113.99", url);
      expect(next).toHaveBeenCalled();
      expect(reply.headers).toEqual({});
    }

    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("emits the contracted header names, unix-second reset, and floored remaining", async () => {
    authoritativeCount = 298;
    const middleware = createMiddleware(queryRaw);

    // First sight flushes: effective = 298 -> remaining 2.
    const first = await makeRequestThrough(middleware);
    expect(first.reply.headers["X-RateLimit-Limit"]).toBe("300");
    expect(first.reply.headers["X-RateLimit-Remaining"]).toBe("2");

    // effective 299 then 300 -> remaining 1 then 0.
    const second = await makeRequestThrough(middleware);
    expect(second.reply.headers["X-RateLimit-Remaining"]).toBe("1");

    const third = await makeRequestThrough(middleware);
    expect(third.next).toHaveBeenCalled();
    expect(third.reply.code).not.toHaveBeenCalled();
    expect(third.reply.headers["X-RateLimit-Remaining"]).toBe("0");
    expect(Object.keys(third.reply.headers).sort()).toEqual([
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
    ]);

    // effective 301 -> blocked, remaining stays floored at 0.
    const fourth = await makeRequestThrough(middleware);
    expect(fourth.next).not.toHaveBeenCalled();
    expect(fourth.reply.code).toHaveBeenCalledWith(429);
    expect(fourth.reply.send).toHaveBeenCalledWith(FOUR_TWENTY_NINE_BODY);
    expect(fourth.reply.headers["X-RateLimit-Remaining"]).toBe("0");
    expect(Number(fourth.reply.headers["X-RateLimit-Reset"])).toBe(
      Math.ceil((Date.now() + 60_000) / 1000),
    );
  });
});
