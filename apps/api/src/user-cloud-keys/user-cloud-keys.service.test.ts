import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSettingValue } from "../common/crypto";
import {
  MAX_USER_CLOUD_KEYS,
  UserCloudKeyError,
  UserCloudKeysService,
} from "./user-cloud-keys.service";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY = "f".repeat(64);

function row(id: string, value: string, role = "cloud") {
  return { id, keyValue: value, role };
}

function makeService(rows: ReturnType<typeof row>[] | Error) {
  const findMany = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const service = new UserCloudKeysService(
    { userCloudKey: { findMany } } as never,
    { firecrawlKeysEncryptionKey: ENCRYPTION_KEY } as never,
    { refreshCreditUsage: vi.fn() } as never,
  );
  return { service, findMany };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("UserCloudKeysService", () => {
  it("decrypts only the requested user's keys, in creation order, with their roles", async () => {
    const { service, findMany } = makeService([
      row("k1", encryptSettingValue("fc-user-key-one-aaaaaaaa", ENCRYPTION_KEY)),
      row("k2", encryptSettingValue("fc-user-key-two-bbbbbbbb", ENCRYPTION_KEY), "fallback"),
    ]);

    const entries = await service.loadEntries("user-1");

    expect(entries).toEqual([
      { key: "fc-user-key-one-aaaaaaaa", role: "cloud" },
      { key: "fc-user-key-two-bbbbbbbb", role: "fallback" },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "asc" },
      select: { id: true, keyValue: true, role: true },
    });
  });

  it("returns no entries for a user without keys", async () => {
    const { service } = makeService([]);

    await expect(service.loadEntries("user-1")).resolves.toEqual([]);
  });

  it("skips plaintext rows and rows it cannot decrypt, without leaking material in logs", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const secret = "fc-secret-that-must-not-be-logged-1234";
    const { service } = makeService([
      row("plain", secret), // not encrypted: not trusted
      row("wrong", encryptSettingValue(secret, OTHER_KEY)), // other encryption key
      row("ok", encryptSettingValue("fc-good-key-aaaaaaaaaaaa", ENCRYPTION_KEY)),
    ]);

    const entries = await service.loadEntries("user-1");

    expect(entries).toEqual([{ key: "fc-good-key-aaaaaaaaaaaa", role: "cloud" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).not.toContain(secret);
    expect(message).toContain("id wrong");
  });

  it("caches per user for a short time and returns copies", async () => {
    vi.useFakeTimers();
    const { service, findMany } = makeService([
      row("k1", encryptSettingValue("fc-user-key-one-aaaaaaaa", ENCRYPTION_KEY)),
    ]);

    const first = await service.loadEntries("user-1");
    first.push({ key: "mutated", role: "cloud" });
    const second = await service.loadEntries("user-1");
    await service.loadEntries("user-2");

    expect(second).toEqual([{ key: "fc-user-key-one-aaaaaaaa", role: "cloud" }]);
    expect(findMany).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_001);
    await service.loadEntries("user-1");
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("reloads right after invalidate", async () => {
    const { service, findMany } = makeService([]);
    await service.loadEntries("user-1");

    service.invalidate("user-1");
    await service.loadEntries("user-1");

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("rejects on a database failure instead of reporting an empty key list", async () => {
    const { service } = makeService(new Error("db down"));

    await expect(service.loadEntries("user-1")).rejects.toThrow("db down");
  });
});

const usage = (overrides: Record<string, unknown> = {}) => ({
  remainingCredits: 120,
  planCredits: 500,
  billingPeriodStart: null,
  billingPeriodEnd: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

function managed(options: { rows?: unknown[]; count?: number; details?: unknown } = {}) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...data,
    createdAt: new Date("2026-10-12T00:00:00.000Z"),
    lastVerifiedAt: data.lastVerifiedAt ?? null,
  }));
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    userCloudKey: {
      findMany: vi
        .fn()
        .mockResolvedValue(Array.from({ length: options.count ?? 0 }, () => ({ keyValue: "x" }))),
      create,
    },
  };
  const prisma = {
    userCloudKey: {
      findMany: vi.fn().mockResolvedValue(options.rows ?? []),
      count: vi.fn().mockResolvedValue(options.count ?? 0),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const credits = { refreshCreditUsage: vi.fn().mockResolvedValue(options.details ?? usage()) };
  const service = new UserCloudKeysService(
    prisma as never,
    { firecrawlKeysEncryptionKey: ENCRYPTION_KEY } as never,
    credits as never,
  );
  return { service, prisma, credits, tx, create };
}

describe("UserCloudKeysService key management", () => {
  const input = { name: "Main", key: "fc-0123456789abcdef", role: "cloud" as const };

  it("verifies a new key with Cloud, then stores it encrypted and never returns it", async () => {
    const { service, create, credits } = managed();

    const result = await service.add("user-1", input);

    expect(credits.refreshCreditUsage).toHaveBeenCalledWith(input.key, { force: true });
    const data = create.mock.calls[0][0].data;
    expect(data.userId).toBe("user-1");
    expect(data.keyValue).not.toContain(input.key);
    expect(data.keyPrefix).toBe("fc-012");
    expect(JSON.stringify(result)).not.toContain(input.key);
    expect(result.status).toMatchObject({ status: "valid", remaining_credits: 120 });
    expect(result.key).toMatchObject({ name: "Main", key_prefix: "fc-012", role: "cloud" });
  });

  it("does not store a key Cloud rejects, or one that could not be checked", async () => {
    const rejected = managed({
      details: usage({ remainingCredits: null, error: "HTTP 401: nope", httpStatus: 401 }),
    });
    await expect(rejected.service.add("user-1", input)).rejects.toMatchObject({
      reason: "invalid_key",
    });
    expect(rejected.create).not.toHaveBeenCalled();

    const down = managed({
      details: usage({ remainingCredits: null, error: "HTTP 503: down", httpStatus: 503 }),
    });
    await expect(down.service.add("user-1", input)).rejects.toMatchObject({
      reason: "unverifiable",
    });
    const timeout = managed({ details: usage({ remainingCredits: null, error: "aborted" }) });
    await expect(timeout.service.add("user-1", input)).rejects.toMatchObject({
      reason: "unverifiable",
    });
    expect(down.create).not.toHaveBeenCalled();
    expect(timeout.create).not.toHaveBeenCalled();
  });

  it("enforces the per-user cap, before and inside the locked transaction", async () => {
    const full = managed({ count: MAX_USER_CLOUD_KEYS });
    await expect(full.service.add("user-1", input)).rejects.toMatchObject({
      reason: "limit_reached",
    });
    expect(full.credits.refreshCreditUsage).not.toHaveBeenCalled();

    // Another request filled the last slot between the pre-check and the transaction.
    const raced = managed();
    raced.tx.userCloudKey.findMany.mockResolvedValue(
      Array.from({ length: MAX_USER_CLOUD_KEYS }, () => ({ keyValue: "x" })),
    );
    await expect(raced.service.add("user-1", input)).rejects.toMatchObject({
      reason: "limit_reached",
    });
    expect(raced.create).not.toHaveBeenCalled();
  });

  it("refuses a key the user already stored", async () => {
    const { service, credits } = managed({
      rows: [row("k1", encryptSettingValue(input.key, ENCRYPTION_KEY))],
      count: 1,
    });
    await expect(service.add("user-1", input)).rejects.toMatchObject({ reason: "duplicate" });
    expect(credits.refreshCreditUsage).not.toHaveBeenCalled();
  });

  it("scopes update and remove to the owner", async () => {
    const { service, prisma } = managed();
    prisma.userCloudKey.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.update("user-1", "k-other", { name: "x" })).resolves.toBeNull();
    expect(prisma.userCloudKey.updateMany).toHaveBeenCalledWith({
      where: { id: "k-other", userId: "user-1" },
      data: { name: "x" },
    });

    prisma.userCloudKey.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove("user-1", "k-other")).resolves.toBe(false);
    expect(prisma.userCloudKey.deleteMany).toHaveBeenCalledWith({
      where: { id: "k-other", userId: "user-1" },
    });
  });

  it("re-checks a stored key with Cloud on demand and rate limits repeats", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, prisma, credits } = managed();
    prisma.userCloudKey.findFirst.mockResolvedValue({
      id: "k1",
      userId: "user-1",
      keyValue: encryptSettingValue("fc-0123456789abcdef", ENCRYPTION_KEY),
    });

    await expect(service.verify("user-1", "k1")).resolves.toMatchObject({
      status: "valid",
      remaining_credits: 120,
    });
    expect(credits.refreshCreditUsage).toHaveBeenCalledWith("fc-0123456789abcdef", {
      force: true,
    });
    expect(prisma.userCloudKey.update).toHaveBeenCalledWith({
      where: { id: "k1" },
      data: { lastVerifiedAt: expect.any(Date) },
    });
    await expect(service.verify("user-1", "k1")).rejects.toBeInstanceOf(UserCloudKeyError);
    vi.setSystemTime(Date.now() + 11_000);
    await expect(service.verify("user-1", "k1")).resolves.toMatchObject({ status: "valid" });
  });

  it("does not verify a key that is not the user's, and keeps last_verified_at on failure", async () => {
    const { service, prisma, credits } = managed({
      details: usage({ remainingCredits: null, error: "HTTP 401: x", httpStatus: 401 }),
    });
    prisma.userCloudKey.findFirst.mockResolvedValueOnce(null);
    await expect(service.verify("user-1", "someone-elses")).resolves.toBeNull();
    expect(prisma.userCloudKey.findFirst).toHaveBeenCalledWith({
      where: { id: "someone-elses", userId: "user-1" },
    });
    expect(credits.refreshCreditUsage).not.toHaveBeenCalled();

    prisma.userCloudKey.findFirst.mockResolvedValueOnce({
      id: "k1",
      keyValue: encryptSettingValue("fc-0123456789abcdef", ENCRYPTION_KEY),
    });
    await expect(service.verify("user-1", "k1")).resolves.toMatchObject({ status: "invalid" });
    expect(prisma.userCloudKey.update).not.toHaveBeenCalled();
  });

  it("stores a key added twice at the same time only once", async () => {
    const { service, prisma, tx, create } = managed();
    // The first add's row is visible to the second add once it holds the lock.
    tx.userCloudKey.findMany
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ keyValue: encryptSettingValue(input.key, ENCRYPTION_KEY) }]);
    // Both adds pass the pre-check and Cloud; only the locked section can tell them apart.
    prisma.userCloudKey.count.mockResolvedValue(0);
    prisma.userCloudKey.findMany.mockResolvedValue([]);

    const results = await Promise.allSettled([
      service.add("user-1", input),
      service.add("user-1", input),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason,
    ).toMatchObject({ reason: "duplicate" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not cache a read that started before the keys changed", async () => {
    const { prisma, service } = managed();
    let release!: (rows: unknown[]) => void;
    prisma.userCloudKey.findMany
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValue([]);

    // A request begins reading the user's keys, then the user deletes one.
    const inFlight = service.loadEntries("user-1");
    await service.remove("user-1", "k1");
    release([row("k1", encryptSettingValue("fc-deleted-key-aaaaaaaa", ENCRYPTION_KEY))]);
    await inFlight;

    // The next request must read again instead of being served the pre-delete rows.
    await expect(service.loadEntries("user-1")).resolves.toEqual([]);
    expect(prisma.userCloudKey.findMany).toHaveBeenCalledTimes(2);
  });
});
