import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "redis";
import { RedisCreditLedgerStore, type RedisCommandClient } from "./credit-ledger.store";

// Opt-in: runs the real Lua scripts against a disposable Redis, e.g.
//   docker run --rm -p 6390:6379 redis:7-alpine
//   REDIS_TEST_URL=redis://localhost:6390 bun run test
const redisUrl = process.env.REDIS_TEST_URL;

describe.skipIf(!redisUrl)("RedisCreditLedgerStore Lua selection (real Redis)", () => {
  const client = createClient({ url: redisUrl });
  let store: RedisCreditLedgerStore;

  beforeAll(async () => {
    await client.connect();
    store = new RedisCreditLedgerStore(
      { redisUrl, requestTimeoutMs: 120_000 } as never,
      client as unknown as RedisCommandClient,
    );
  });
  beforeEach(async () => {
    await client.flushDb();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await client.quit();
  });

  const seed = (id: string, credits: number, renewsAt: string | null) =>
    store.reconcile(id, credits, 0, renewsAt ? Date.parse(renewsAt) : 0);

  async function pick(ids: string[]): Promise<number> {
    const result = await store.reserve(ids, 1);
    expect(result.kind).toBe("reserved");
    return result.kind === "reserved" ? result.index : -1;
  }

  it("prefers the earliest renewal day even with fewer credits", async () => {
    await seed("a", 900, "2026-09-20T00:00:00Z");
    await seed("b", 10, "2026-09-05T12:00:00Z");
    expect(await pick(["a", "b"])).toBe(1);
  });

  it("treats different times on the same UTC day as a tie, then prefers more credits", async () => {
    await seed("a", 100, "2026-09-05T01:00:00Z");
    await seed("b", 500, "2026-09-05T23:59:00Z");
    await seed("c", 900, "2026-09-06T00:00:00Z");
    expect(await pick(["a", "b", "c"])).toBe(1);
  });

  it("sorts unknown renewal last", async () => {
    await seed("a", 900, null);
    await seed("b", 10, "2027-01-01T00:00:00Z");
    expect(await pick(["a", "b"])).toBe(1);
  });

  it.each([
    [0, 0],
    [0.99, 1],
  ])("picks randomly among exact ties (random %s -> index %s)", async (value, expected) => {
    await seed("a", 50, "2026-09-05T00:00:00Z");
    await seed("b", 50, "2026-09-05T10:00:00Z");
    vi.spyOn(Math, "random").mockReturnValueOnce(value);
    expect(await pick(["a", "b"])).toBe(expected);
  });

  it("skips disabled, cooled-down and empty pools, and keeps return shapes", async () => {
    await seed("a", 0, "2026-09-01T00:00:00Z");
    await seed("b", 5, "2026-09-02T00:00:00Z");
    expect(await store.reserve(["a"], 1)).toEqual({ kind: "no-capacity" });
    expect(await pick(["a", "b"])).toBe(1);
    expect(await store.reserve(["never-seeded"], 1)).toEqual({ kind: "unavailable" });
  });
});
