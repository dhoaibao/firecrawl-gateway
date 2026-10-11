import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitCounter } from "./rate-limit-counter";

type Sql = { values: unknown[]; sql: string };

function makeCounter(queryRaw: ReturnType<typeof vi.fn>) {
  return new RateLimitCounter({ $queryRaw: queryRaw } as never);
}

describe("RateLimitCounter fixed reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes no fixed reset by default, keeping the one-minute window", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ count: 1, reset_at: new Date(Date.now() + 60_000) }]);
    const counter = makeCounter(queryRaw);

    const hit = await counter.hit("203.0.113.1");

    const sql = queryRaw.mock.calls[0][0] as Sql;
    expect(sql.values).toEqual(["203.0.113.1", 1, null, 1, 1, null]);
    expect(sql.sql).toContain("interval '1 minute'");
    expect(hit).toEqual({ count: 1, resetAt: Date.now() + 60_000 });
  });

  it("pins the window end when a fixed reset is given and uses the stored value afterwards", async () => {
    const monthEnd = new Date("2026-11-01T00:00:00.000Z");
    const queryRaw = vi.fn().mockResolvedValue([{ count: 7, reset_at: monthEnd }]);
    const counter = makeCounter(queryRaw);

    const hit = await counter.hit("quota:key-1:2026-10", monthEnd);

    const sql = queryRaw.mock.calls[0][0] as Sql;
    expect(sql.values).toEqual(["quota:key-1:2026-10", 1, monthEnd, 1, 1, monthEnd]);
    expect(hit).toEqual({ count: 7, resetAt: monthEnd.getTime() });
  });

  describe("scheduled flush and drain", () => {
    const ok = () => [{ count: 1, reset_at: new Date(Date.now() + 60_000) }];

    it("does not flush an idle bucket on a timer unless scheduling is enabled", async () => {
      const queryRaw = vi.fn().mockImplementation(async () => ok());
      const counter = makeCounter(queryRaw);

      await counter.hit("203.0.113.1");
      await counter.hit("203.0.113.1"); // pending, no more traffic
      await vi.advanceTimersByTimeAsync(30_000);

      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it("flushes an idle bucket after the flush interval when scheduling is enabled", async () => {
      const monthEnd = new Date("2026-11-01T00:00:00.000Z");
      const queryRaw = vi.fn().mockImplementation(async () => [{ count: 1, reset_at: monthEnd }]);
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });

      await counter.hit("quota:key-1:2026-10", monthEnd);
      await counter.hit("quota:key-1:2026-10", monthEnd);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(queryRaw).toHaveBeenCalledTimes(2);
      // The scheduled flush keeps the pinned window end rather than falling back to one minute.
      const sql = queryRaw.mock.calls[1][0] as Sql;
      expect(sql.values).toEqual(["quota:key-1:2026-10", 1, monthEnd, 1, 1, monthEnd]);
    });

    it("drains every pending bucket and cancels timers", async () => {
      const queryRaw = vi.fn().mockImplementation(async () => ok());
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });
      await counter.hit("a");
      await counter.hit("a");
      await counter.hit("b");
      await counter.hit("b");
      expect(queryRaw).toHaveBeenCalledTimes(2);

      await counter.drain();

      expect(queryRaw).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(queryRaw).toHaveBeenCalledTimes(4);
      // Nothing is pending afterwards, so a second drain is a no-op.
      await counter.drain();
      expect(queryRaw).toHaveBeenCalledTimes(4);
    });

    it("never flushes an expired window's increments into the next window", async () => {
      // A tiny fake of the upsert: the database count follows the window the caller's flush lands in.
      let dbCount = 0;
      let dbResetAt = 0;
      const queryRaw = vi.fn().mockImplementation(async (sql: Sql) => {
        const delta = Number(sql.values[1]);
        if (dbResetAt <= Date.now()) {
          dbCount = delta;
          dbResetAt = Date.now() + 60_000;
        } else dbCount += delta;
        return [{ count: dbCount, reset_at: new Date(dbResetAt) }];
      });
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });

      await counter.hit("key:key-1"); // t=0 s, window ends at 60 s
      await vi.advanceTimersByTimeAsync(59_000);
      await counter.hit("key:key-1"); // t=59 s: flushes (more than 5 s since the last)
      await vi.advanceTimersByTimeAsync(500);
      await counter.hit("key:key-1"); // t=59.5 s: pending, flush scheduled for t=64 s
      expect(queryRaw).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10_500); // t=70 s: the timer fired after the window ended
      expect(queryRaw).toHaveBeenCalledTimes(2);

      const fresh = await counter.hit("key:key-1"); // a new window starts from 1

      expect(fresh.count).toBe(1);
      expect(queryRaw).toHaveBeenCalledTimes(3);
      expect((queryRaw.mock.calls[2][0] as Sql).values[1]).toBe(1);
    });

    it("drops an expired bucket's pending increments on drain instead of writing them", async () => {
      const queryRaw = vi.fn().mockImplementation(async () => ok());
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });
      await counter.hit("key:key-1");
      await counter.hit("key:key-1"); // pending
      vi.setSystemTime(Date.now() + 120_000); // past the window end, without running timers

      await counter.drain();

      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it("re-arms the scheduled flush after a failure so idle usage is not stranded", async () => {
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce(ok()) // first sight
        .mockRejectedValueOnce(new Error("db blip")) // scheduled flush fails
        .mockResolvedValue(ok());
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });
      await counter.hit("quota:key-1:2026-10", new Date(Date.now() + 86_400_000));
      await counter.hit("quota:key-1:2026-10", new Date(Date.now() + 86_400_000));

      await vi.advanceTimersByTimeAsync(5_000); // fails
      expect(queryRaw).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000); // retried without any new request

      expect(queryRaw).toHaveBeenCalledTimes(3);
      const retriedDelta = (queryRaw.mock.calls[2][0] as Sql).values[1];
      expect(retriedDelta).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(queryRaw).toHaveBeenCalledTimes(3);
    });

    it("stops retrying once the window itself has ended", async () => {
      const queryRaw = vi.fn().mockRejectedValue(new Error("db down"));
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });
      await counter.hit("key:key-1"); // one-minute window, flush fails, pending stays
      await counter.hit("key:key-1");

      await vi.advanceTimersByTimeAsync(90_000);
      const callsAfterWindow = queryRaw.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(callsAfterWindow).toBeGreaterThan(1);
      expect(queryRaw).toHaveBeenCalledTimes(callsAfterWindow);
    });

    it("waits for a timer-started write already in flight and retries it if it fails", async () => {
      let rejectInFlight!: (error: Error) => void;
      const queryRaw = vi
        .fn()
        .mockResolvedValueOnce(ok()) // first sight
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectInFlight = reject;
            }),
        ) // the scheduled flush hangs
        .mockResolvedValue(ok()); // the drain's retry
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });
      await counter.hit("key:key-1");
      await counter.hit("key:key-1");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(queryRaw).toHaveBeenCalledTimes(2);

      let drained = false;
      const draining = counter.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false); // still waiting on the in-flight write

      rejectInFlight(new Error("connection reset"));
      await draining;

      expect(queryRaw).toHaveBeenCalledTimes(3);
      expect((queryRaw.mock.calls[2][0] as Sql).values[1]).toBe(1);
    });

    it("keeps pending counts when a drain flush fails and never throws", async () => {
      const queryRaw = vi.fn().mockResolvedValueOnce(ok()).mockRejectedValue(new Error("db down"));
      const counter = new RateLimitCounter({ $queryRaw: queryRaw } as never, {
        scheduleFlush: true,
      });
      await counter.hit("a");
      await counter.hit("a");

      await expect(counter.drain()).resolves.toBeUndefined();

      const hit = await counter.hit("a");
      expect(hit.count).toBe(1 + 2);
    });
  });

  it("starts the local bucket at the fixed end so a month-long window is not cut at one minute", async () => {
    const monthEnd = new Date("2026-11-01T00:00:00.000Z");
    // The database is unreachable: the bucket's own provisional reset must still be the month end.
    const queryRaw = vi.fn().mockRejectedValue(new Error("db down"));
    const counter = makeCounter(queryRaw);

    const first = await counter.hit("quota:key-1:2026-10", monthEnd);
    vi.advanceTimersByTime(10 * 60_000);
    const second = await counter.hit("quota:key-1:2026-10", monthEnd);

    expect(first.resetAt).toBe(monthEnd.getTime());
    // Ten minutes later the same bucket is still counting: two requests, not a fresh window.
    expect(second.count).toBe(2);
  });
});
