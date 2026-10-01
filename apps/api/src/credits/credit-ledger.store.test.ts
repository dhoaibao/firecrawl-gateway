import { describe, expect, it, vi } from "vitest";
import { RedisCreditLedgerStore } from "./credit-ledger.store";

const config = {
  redisUrl: "redis://localhost:6379",
};

describe("RedisCreditLedgerStore", () => {
  it("uses one atomic Lua reservation across all candidate pools", async () => {
    const client = {
      isOpen: true,
      connect: vi.fn(),
      quit: vi.fn(),
      eval: vi
        .fn()
        .mockResolvedValue([2, 7, "firecrawl-gateway:credit-ledger:v1:reservation:opaque"]),
    };
    const store = new RedisCreditLedgerStore(config as never, client as never);

    const result = await store.reserve(["hmac-key-1", "hmac-key-2"], 3);

    expect(result).toEqual({
      kind: "reserved",
      index: 1,
      sequence: 7,
      reservationKey: "firecrawl-gateway:credit-ledger:v1:reservation:opaque",
    });
    expect(client.eval).toHaveBeenCalledTimes(1);
    const options = client.eval.mock.calls[0][1] as { keys: string[]; arguments: string[] };
    expect(options.keys).toHaveLength(6);
    expect(options.arguments).toEqual([expect.any(String), "3", "300", expect.any(String)]);
    const script = client.eval.mock.calls[0][0] as string;
    expect(script).toContain("renewsAt");
    expect(script).toContain("ties");
    expect(options.keys.join(" ")).not.toContain("fc_secret_api_key_one");
    expect(options.keys.join(" ")).not.toContain("fc_secret_api_key_two");
  });

  it("distinguishes an initialized pool with no capacity from a Redis outage", async () => {
    const client = {
      isOpen: true,
      connect: vi.fn(),
      quit: vi.fn(),
      eval: vi.fn().mockResolvedValue([0, 0]),
    };
    const store = new RedisCreditLedgerStore(config as never, client as never);

    await expect(store.reserve(["opaque-key"], 1)).resolves.toEqual({ kind: "no-capacity" });
  });

  it("deletes finalized reservation hashes and bounds open reservations", async () => {
    const client = {
      isOpen: true,
      connect: vi.fn(),
      quit: vi.fn(),
      eval: vi
        .fn()
        .mockResolvedValueOnce([1, 1, "reservation-key"])
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1),
    };
    const store = new RedisCreditLedgerStore(
      { ...config, requestTimeoutMs: 120_000 } as never,
      client as never,
    );

    await store.reserve(["opaque-key"], 1);
    await store.settle("opaque-key", "reservation-key", "disabled");
    await store.reconcile("opaque-key", 10, 1);

    const scripts = client.eval.mock.calls.map(([script]) => String(script));
    expect(scripts[0]).toContain("EXPIRE");
    expect(scripts[1]).toContain("DEL");
    expect(scripts[2]).toContain("DEL");
  });

  it("settles actual usage through an atomic reservation adjustment", async () => {
    const client = {
      isOpen: true,
      connect: vi.fn(),
      quit: vi.fn(),
      eval: vi.fn().mockResolvedValue(1),
    };
    const store = new RedisCreditLedgerStore(config as never, client as never);

    await expect(store.settleActualUsage("opaque-key", "opaque-reservation", 4)).resolves.toBe(
      true,
    );
    const [script, options] = client.eval.mock.calls[0] as [
      string,
      { keys: string[]; arguments: string[] },
    ];
    expect(script).toContain("math.min");
    expect(script).toContain("HINCRBY");
    expect(script).toContain("DEL");
    expect(options.arguments).toEqual(["4"]);
  });

  it("captures a reservation sequence and reconciles through Redis", async () => {
    const client = {
      isOpen: true,
      connect: vi.fn(),
      quit: vi.fn(),
      eval: vi
        .fn()
        .mockResolvedValueOnce("4")
        .mockResolvedValueOnce("425")
        .mockResolvedValueOnce(1),
    };
    const store = new RedisCreditLedgerStore(config as never, client as never);

    await expect(store.capture("opaque-key")).resolves.toEqual({ available: true, sequence: 4 });
    await expect(store.reconcile("opaque-key", 425, 4)).resolves.toBe(true);
    await expect(store.settle("opaque-key", "opaque-reservation", "cooldown", 123)).resolves.toBe(
      true,
    );
    expect(client.eval).toHaveBeenCalledTimes(3);
  });
});
