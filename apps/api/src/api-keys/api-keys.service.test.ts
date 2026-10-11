import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeysService } from "./api-keys.service";

const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    name: "global",
    keyHash: "hash",
    keyValue: null,
    keyPrefix: "fc_test",
    revoked: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUsedAt: null,
    ...overrides,
  };
}

describe("ApiKeysService", () => {
  it("creates global keys without a user owner", async () => {
    const prisma = { apiKey: { create: vi.fn().mockResolvedValue(row()) } };
    const service = new ApiKeysService(
      prisma as never,
      { firecrawlKeysEncryptionKey: encryptionKey } as never,
    );

    const created = await service.createApiKey("global");

    expect(prisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ userId: expect.anything() }),
    });
    expect(created).toEqual(
      expect.objectContaining({ id: "key-1", name: "global", key: expect.stringMatching(/^fc_/) }),
    );
  });

  it("stores optional limits on create only when provided", async () => {
    const prisma = {
      apiKey: {
        create: vi.fn().mockResolvedValue(
          row({
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
            rateLimitPerMinute: 30,
          }),
        ),
      },
    };
    const service = new ApiKeysService(
      prisma as never,
      { firecrawlKeysEncryptionKey: encryptionKey } as never,
    );

    const created = await service.createApiKey("limited", {
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      rateLimitPerMinute: 30,
    });

    expect(prisma.apiKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        rateLimitPerMinute: 30,
      }),
    });
    expect(created).toMatchObject({
      expires_at: "2030-01-01T00:00:00.000Z",
      rate_limit_per_minute: 30,
    });
  });

  it("maps legacy rows without limits to null", async () => {
    const prisma = { apiKey: { findMany: vi.fn().mockResolvedValue([row()]) } };
    const service = new ApiKeysService(prisma as never, {} as never);

    const [key] = await service.listApiKeys();

    expect(key).toMatchObject({ expires_at: null, rate_limit_per_minute: null });
  });

  it("applies updated limits immediately by evicting the validation cache", async () => {
    const key = "fc_global-limits";
    const service = new ApiKeysService({} as never, {} as never);
    const keyHash = service.hashApiKey(key);
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(row({ keyHash, rateLimitPerMinute: null }))
      .mockResolvedValueOnce(row({ keyHash, rateLimitPerMinute: 5 }));
    const update = vi.fn().mockResolvedValue(row({ keyHash, rateLimitPerMinute: 5 }));
    const limited = new ApiKeysService({ apiKey: { findFirst, update } } as never, {} as never);

    expect((await limited.validateApiKey(key))?.rate_limit_per_minute).toBeNull();
    await limited.updateApiKeyLimits("key-1", { rateLimitPerMinute: 5 });
    expect((await limited.validateApiKey(key))?.rate_limit_per_minute).toBe(5);

    expect(update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { rateLimitPerMinute: 5 },
    });
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("returns null when updating limits of an unknown key", async () => {
    const { Prisma } = await import("@prisma/client");
    const error = new Prisma.PrismaClientKnownRequestError("missing", {
      code: "P2025",
      clientVersion: "test",
    });
    const service = new ApiKeysService(
      { apiKey: { update: vi.fn().mockRejectedValue(error) } } as never,
      {} as never,
    );

    await expect(service.updateApiKeyLimits("missing", { expiresAt: null })).resolves.toBeNull();
  });

  describe("per-key rate limit", () => {
    function limitedService(count: () => number) {
      const queryRaw = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve([{ count: count(), reset_at: new Date(Date.now() + 60_000) }]),
        );
      const service = new ApiKeysService({ $queryRaw: queryRaw } as never, {} as never);
      return { service, queryRaw };
    }
    const key = (limit: number | null) => ({ id: "key-1", rate_limit_per_minute: limit }) as never;

    it("does nothing for a key without a limit", async () => {
      const { service, queryRaw } = limitedService(() => 0);

      await expect(service.hitRateLimit(key(null))).resolves.toBeNull();
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it("counts under a key-scoped bucket and reports the boundary exactly", async () => {
      // The first hit syncs with Postgres, whose count already includes it (2).
      const { service, queryRaw } = limitedService(() => 2);

      const first = await service.hitRateLimit(key(3)); // 2
      const atLimit = await service.hitRateLimit(key(3)); // 3: still allowed
      const over = await service.hitRateLimit(key(3)); // 4 > 3

      expect(first).toMatchObject({ limit: 3, remaining: 1, exceeded: false });
      expect(atLimit).toMatchObject({ remaining: 0, exceeded: false });
      expect(over).toMatchObject({ remaining: 0, exceeded: true });
      expect((queryRaw.mock.calls[0][0] as { values: unknown[] }).values[0]).toBe("key:key-1");
      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it("keeps separate counters for different keys", async () => {
      const { service } = limitedService(() => 0);

      await service.hitRateLimit({ id: "a", rate_limit_per_minute: 1 } as never);
      const other = await service.hitRateLimit({ id: "b", rate_limit_per_minute: 1 } as never);

      expect(other).toMatchObject({ exceeded: false });
    });
  });

  describe("monthly quota", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function quotaService(count: () => number) {
      const queryRaw = vi
        .fn()
        .mockImplementation((_sql: unknown) =>
          Promise.resolve([{ count: count(), reset_at: new Date("2026-11-01T00:00:00.000Z") }]),
        );
      return {
        service: new ApiKeysService({ $queryRaw: queryRaw } as never, {} as never),
        queryRaw,
      };
    }
    const key = (quota: number | null) => ({ id: "key-1", monthly_quota: quota }) as never;

    it("does nothing for a key without a quota", async () => {
      const { service, queryRaw } = quotaService(() => 0);

      await expect(service.hitQuota(key(null))).resolves.toBeNull();
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it("counts under a per-month key that ends at the start of the next UTC month", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-31T23:59:30.000Z"));
      const { service, queryRaw } = quotaService(() => 3);

      const result = await service.hitQuota(key(3));

      const sql = queryRaw.mock.calls[0][0] as { values: unknown[] };
      expect(sql.values[0]).toBe("quota:key-1:2026-10");
      expect(sql.values).toContainEqual(new Date("2026-11-01T00:00:00.000Z"));
      expect(result).toMatchObject({ limit: 3, remaining: 0, exceeded: false });
    });

    it("reports the boundary exactly: the request over the quota is the first one exceeded", async () => {
      const { service } = quotaService(() => 2);

      const first = await service.hitQuota(key(3)); // 2
      const second = await service.hitQuota(key(3)); // 3
      const third = await service.hitQuota(key(3)); // 4

      expect(first).toMatchObject({ remaining: 1, exceeded: false });
      expect(second).toMatchObject({ remaining: 0, exceeded: false });
      expect(third).toMatchObject({ remaining: 0, exceeded: true });
    });

    it("starts a fresh counter in the next month", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-31T23:59:59.000Z"));
      const { service, queryRaw } = quotaService(() => 1);

      await service.hitQuota(key(1));
      vi.setSystemTime(new Date("2026-11-01T00:00:01.000Z"));
      await service.hitQuota(key(1));

      const keys = queryRaw.mock.calls.map(([sql]) => (sql as { values: unknown[] }).values[0]);
      expect(keys).toEqual(["quota:key-1:2026-10", "quota:key-1:2026-11"]);
    });

    it("keeps counting from memory while the database is down, never rejecting within quota", async () => {
      const service = new ApiKeysService(
        { $queryRaw: vi.fn().mockRejectedValue(new Error("db down")) } as never,
        {} as never,
      );

      const results = [];
      for (let i = 0; i < 4; i += 1) results.push(await service.hitQuota(key(3)));

      // In-memory counts are a lower bound of real usage: allowed up to the quota, rejected after.
      expect(results.map((result) => result?.exceeded)).toEqual([false, false, false, true]);
    });

    it("flushes idle usage on a timer and drains pending counts at shutdown", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
      const queryRaw = vi
        .fn()
        .mockResolvedValue([{ count: 1, reset_at: new Date("2026-11-01T00:00:00.000Z") }]);
      const service = new ApiKeysService({ $queryRaw: queryRaw } as never, {} as never);

      await service.hitQuota(key(100)); // first sight: flushes immediately
      await service.hitQuota(key(100)); // pending, no further traffic follows
      expect(queryRaw).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(queryRaw).toHaveBeenCalledTimes(2);

      await service.hitQuota(key(100)); // pending again, then the process shuts down
      await service.onModuleDestroy();
      expect(queryRaw).toHaveBeenCalledTimes(3);
      const lastDelta = (queryRaw.mock.calls[2][0] as { values: unknown[] }).values[1];
      expect(lastDelta).toBe(1);
    });

    it("reads this month's used count for keys that have a quota only", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
      const findMany = vi.fn().mockResolvedValue([{ key: "quota:with:2026-10", count: 42 }]);
      const service = new ApiKeysService({ rateLimit: { findMany } } as never, {} as never);

      const usage = await service.quotaUsage([
        { id: "with", monthly_quota: 100 },
        { id: "without", monthly_quota: null },
      ] as never);

      expect(findMany).toHaveBeenCalledWith({
        where: { key: { in: ["quota:with:2026-10"] }, resetAt: { gt: new Date() } },
        select: { key: true, count: true },
      });
      expect(usage.get("with")).toBe(42);
      expect(usage.has("without")).toBe(false);
    });

    it("skips the query when no key has a quota", async () => {
      const findMany = vi.fn();
      const service = new ApiKeysService({ rateLimit: { findMany } } as never, {} as never);

      await expect(
        service.quotaUsage([{ id: "a", monthly_quota: null }] as never),
      ).resolves.toEqual(new Map());
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  describe("portal user ownership", () => {
    function ownedService(owner: unknown) {
      const service = new ApiKeysService({} as never, {} as never);
      const keyHash = service.hashApiKey("fc_owned");
      const prisma = {
        apiKey: { findFirst: vi.fn().mockResolvedValue(row({ keyHash, userId: "user-1" })) },
        user: { findUnique: vi.fn().mockResolvedValue(owner) },
      };
      return {
        prisma,
        service: new ApiKeysService(prisma as never, {} as never),
      };
    }

    it("exposes the owner on the validated record", async () => {
      const { service, prisma } = ownedService({ status: "active", deletedAt: null });

      const key = await service.validateApiKey("fc_owned");

      expect(key?.user_id).toBe("user-1");
      expect(key?.owner_active).toBe(true);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: "user-1" },
        select: { status: true, deletedAt: true },
      });
    });

    it.each([
      ["a suspended owner", { status: "suspended", deletedAt: null }],
      ["a deleted owner", { status: "active", deletedAt: new Date() }],
      ["a missing owner", null],
    ])("flags the key as owned by an inactive account for %s", async (_name, owner) => {
      const { service } = ownedService(owner);

      // Recognised, not dropped: callers must be able to refuse it instead of treating it
      // as an unknown (anonymous) key.
      await expect(service.validateApiKey("fc_owned")).resolves.toMatchObject({
        id: "key-1",
        user_id: "user-1",
        owner_active: false,
      });
    });

    it("does not look up an owner for global keys", async () => {
      const service = new ApiKeysService({} as never, {} as never);
      const keyHash = service.hashApiKey("fc_global");
      const prisma = {
        apiKey: { findFirst: vi.fn().mockResolvedValue(row({ keyHash })) },
        user: { findUnique: vi.fn() },
      };
      const global = new ApiKeysService(prisma as never, {} as never);

      const key = await global.validateApiKey("fc_global");

      expect(key).toMatchObject({ id: "key-1", user_id: null, owner_active: true });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  it("validates a non-revoked key without loading a user relation", async () => {
    const key = "fc_global-test";
    const prisma = {
      apiKey: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            row({ keyHash: new ApiKeysService({} as never, {} as never).hashApiKey(key) }),
          ),
      },
    };
    const service = new ApiKeysService(
      prisma as never,
      { firecrawlKeysEncryptionKey: encryptionKey } as never,
    );

    const validated = await service.validateApiKey(key);

    expect(validated?.id).toBe("key-1");
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { keyHash: service.hashApiKey(key), revoked: false },
    });
  });

  it("bounds validation cache entries for distinct caller-supplied keys", async () => {
    const prisma = { apiKey: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new ApiKeysService(
      prisma as never,
      { firecrawlKeysEncryptionKey: encryptionKey } as never,
    );

    for (let index = 0; index <= 10_000; index++)
      await service.validateApiKey(`fc_distinct-${index}`);

    const cache = (service as unknown as { validationCache: Map<string, unknown> }).validationCache;
    expect(cache.size).toBe(10_000);
  });

  it("deduplicates validation and rejects a cached key immediately after revocation", async () => {
    const key = "fc_global-cached";
    let service!: ApiKeysService;
    const prisma = {
      apiKey: {
        findFirst: vi.fn().mockResolvedValue(row({ keyHash: "unused" })),
        update: vi
          .fn()
          .mockImplementation(async () => row({ keyHash: service.hashApiKey(key), revoked: true })),
      },
    };
    prisma.apiKey.findFirst.mockResolvedValue(
      row({ keyHash: new ApiKeysService({} as never, {} as never).hashApiKey(key) }),
    );
    service = new ApiKeysService(
      prisma as never,
      { firecrawlKeysEncryptionKey: encryptionKey } as never,
    );

    const validations = await Promise.all([
      service.validateApiKey(key),
      service.validateApiKey(key),
    ]);

    expect(validations[0]?.id).toBe("key-1");
    expect(validations[1]?.id).toBe("key-1");
    expect(prisma.apiKey.findFirst).toHaveBeenCalledTimes(1);

    await service.revokeApiKey("key-1");
    prisma.apiKey.findFirst.mockResolvedValue(null);

    await expect(service.validateApiKey(key)).resolves.toBeNull();
    expect(prisma.apiKey.findFirst).toHaveBeenCalledTimes(2);
  });
});
