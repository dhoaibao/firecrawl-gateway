import { describe, expect, it, vi } from "vitest";
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
