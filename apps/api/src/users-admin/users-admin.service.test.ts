import { describe, expect, it, vi } from "vitest";
import { UserAdminError, UsersAdminService } from "./users-admin.service";

const now = new Date("2026-10-12T00:00:00.000Z");

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "a@b.c",
    name: "A",
    avatarUrl: null,
    role: "user",
    status: "active",
    maxApiKeys: null,
    rateLimitPerMinute: null,
    monthlyQuota: null,
    createdAt: now,
    lastLoginAt: null,
    deletedAt: null,
    identities: [{ provider: "github", email: "a@b.c", createdAt: now }],
    _count: { cloudKeys: 2 },
    ...overrides,
  };
}

function make() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    user: {
      findUnique: vi.fn().mockResolvedValue(userRow()),
      update: vi.fn().mockResolvedValue({}),
    },
    apiKey: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    userCloudKey: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    userSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    user: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([userRow()]),
      findUnique: vi.fn().mockResolvedValue(userRow()),
    },
    apiKey: {
      groupBy: vi.fn().mockResolvedValue([{ userId: "u1", _count: { _all: 3 } }]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    userCloudKey: { findMany: vi.fn().mockResolvedValue([]) },
    userSession: { count: vi.fn().mockResolvedValue(1) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  };
  const apiKeys = { clearValidationCache: vi.fn() };
  const userCloudKeys = { invalidate: vi.fn() };
  const service = new UsersAdminService(prisma as never, apiKeys as never, userCloudKeys as never);
  return { service, prisma, tx, apiKeys, userCloudKeys };
}

describe("UsersAdminService.list", () => {
  it("summarises users with active key counts and never exposes secrets", async () => {
    const { service, prisma } = make();

    const result = await service.list({ state: "active", limit: 25, offset: 0, search: "a@" });

    expect(result.total).toBe(1);
    expect(result.users[0]).toMatchObject({
      id: "u1",
      state: "active",
      providers: ["github"],
      api_keys: 3,
      cloud_keys: 2,
      limits: { max_api_keys: null, rate_limit_per_minute: null, monthly_quota: null },
    });
    expect(JSON.stringify(result)).not.toMatch(/key_hash|keyValue|key_value|tokenHash/);
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ deletedAt: null, status: "active" });
    expect(where.OR).toHaveLength(2);
    expect(prisma.apiKey.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: ["u1"] }, revoked: false } }),
    );
  });

  it("filters deleted and suspended users", async () => {
    const { service, prisma } = make();
    await service.list({ state: "deleted", limit: 10, offset: 0 });
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ deletedAt: { not: null } });
    await service.list({ state: "suspended", limit: 10, offset: 0 });
    expect(prisma.user.findMany.mock.calls[1][0].where).toEqual({
      deletedAt: null,
      status: "suspended",
    });
  });
});

describe("UsersAdminService.update", () => {
  it("suspends: status and session revocation in one locked transaction, caches dropped", async () => {
    const { service, tx, apiKeys } = make();

    await service.update("u1", { status: "suspended" });

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { status: "suspended" },
    });
    expect(tx.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(apiKeys.clearValidationCache).toHaveBeenCalled();
    expect(tx.apiKey.updateMany).not.toHaveBeenCalled();
    // The per-user lock is taken before the user is read or changed.
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.findUnique.mock.invocationCallOrder[0],
    );
    expect(tx.user.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.update.mock.invocationCallOrder[0],
    );
  });

  it("reactivating does not touch sessions", async () => {
    const { service, tx } = make();
    await service.update("u1", { status: "active" });
    expect(tx.userSession.updateMany).not.toHaveBeenCalled();
  });

  it("applies changed limits to the user's active keys, falling back to the default when cleared", async () => {
    const { service, tx } = make();

    await service.update("u1", { rateLimitPerMinute: 30, monthlyQuota: 1000, maxApiKeys: 2 });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { rateLimitPerMinute: 30, monthlyQuota: 1000, maxApiKeys: 2 },
    });
    expect(tx.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revoked: false },
      data: { rateLimitPerMinute: 30, monthlyQuota: 1000 },
    });

    await service.update("u1", { rateLimitPerMinute: null, monthlyQuota: null });
    expect(tx.apiKey.updateMany).toHaveBeenLastCalledWith({
      where: { userId: "u1", revoked: false },
      data: { rateLimitPerMinute: 120, monthlyQuota: null },
    });
  });

  it("does not change an unknown or deleted user", async () => {
    const { service, tx } = make();
    tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.update("x", { status: "suspended" })).rejects.toMatchObject({
      reason: "not_found",
    });
    tx.user.findUnique.mockResolvedValueOnce(userRow({ deletedAt: now }));
    await expect(service.update("u1", { status: "active" })).rejects.toBeInstanceOf(UserAdminError);
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe("UsersAdminService.remove", () => {
  it("soft-deletes in one locked transaction and clears the caches", async () => {
    const { service, tx, apiKeys, userCloudKeys } = make();

    await service.remove("u1");

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revoked: false },
      data: { revoked: true },
    });
    expect(tx.userCloudKey.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(tx.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(apiKeys.clearValidationCache).toHaveBeenCalled();
    expect(userCloudKeys.invalidate).toHaveBeenCalledWith("u1");
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.findUnique.mock.invocationCallOrder[0],
    );
  });

  it("refuses an unknown or already deleted user without side effects", async () => {
    const { service, tx, apiKeys } = make();
    tx.user.findUnique.mockResolvedValueOnce(userRow({ deletedAt: now }));
    await expect(service.remove("u1")).rejects.toMatchObject({ reason: "deleted" });
    tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(service.remove("zzz")).rejects.toMatchObject({ reason: "not_found" });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.userSession.updateMany).not.toHaveBeenCalled();
    expect(apiKeys.clearValidationCache).not.toHaveBeenCalled();
  });
});

describe("UsersAdminService.get", () => {
  it("returns identities, keys without hashes, and Cloud keys without secrets", async () => {
    const { service, prisma } = make();
    prisma.user.findUnique.mockResolvedValueOnce(
      userRow({
        identities: [{ provider: "google", email: "a@b.c", createdAt: now }],
        rateLimitPerMinute: 30,
      }),
    );
    prisma.apiKey.findMany.mockResolvedValueOnce([
      {
        id: "k1",
        name: "CI",
        keyPrefix: "fc_abc",
        keyHash: "SECRETHASH",
        keyValue: null,
        revoked: false,
        createdAt: now,
        lastUsedAt: null,
        expiresAt: null,
        rateLimitPerMinute: 30,
        monthlyQuota: null,
      },
    ]);
    prisma.userCloudKey.findMany.mockResolvedValueOnce([
      {
        id: "c1",
        name: "Main",
        keyPrefix: "fc-012",
        keyValue: "ENCRYPTEDSECRET",
        role: "cloud",
        createdAt: now,
        lastVerifiedAt: null,
      },
    ]);

    const detail = await service.get("u1");

    expect(detail.effective_limits).toEqual({
      max_api_keys: 10,
      rate_limit_per_minute: 30,
      monthly_quota: null,
    });
    expect(detail.api_keys).toBe(1);
    expect(detail.active_sessions).toBe(1);
    expect(detail.identities).toEqual([
      { provider: "google", email: "a@b.c", linked_at: now.toISOString() },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/SECRETHASH|ENCRYPTEDSECRET/);
  });
});
