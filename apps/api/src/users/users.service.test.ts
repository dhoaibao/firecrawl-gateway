import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AccountDisabledError,
  AccountExistsError,
  IdentityInUseError,
  UsersService,
} from "./users.service";

const profile = {
  provider: "github" as const,
  providerUserId: "42",
  email: "a@b.c",
  name: "A",
  avatarUrl: null,
};

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    email: "a@b.c",
    name: "A",
    avatarUrl: null,
    role: "user",
    status: "active",
    deletedAt: null,
    ...overrides,
  };
}

function prismaMock() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    user: { findUnique: vi.fn().mockResolvedValue({ status: "active", deletedAt: null }) },
    userSession: { create: vi.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
    userIdentity: { findUnique: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    userSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
}

describe("UsersService.resolveOAuthUser", () => {
  it("signs a known provider account into its user", async () => {
    const prisma = prismaMock();
    prisma.userIdentity.findUnique.mockResolvedValue({ user: userRow() });
    const service = new UsersService(prisma as never);
    await expect(service.resolveOAuthUser(profile)).resolves.toMatchObject({ id: "u1" });
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.userIdentity.create).not.toHaveBeenCalled();
  });

  it("does not link a new provider through a matching email (it may be stale)", async () => {
    const prisma = prismaMock();
    prisma.userIdentity.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(userRow());
    const service = new UsersService(prisma as never);
    await expect(service.resolveOAuthUser(profile)).rejects.toBeInstanceOf(AccountExistsError);
    expect(prisma.userIdentity.create).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("creates a user and identity for a new account", async () => {
    const prisma = prismaMock();
    prisma.userIdentity.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(userRow());
    const service = new UsersService(prisma as never);
    await service.resolveOAuthUser(profile);
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "a@b.c",
        identities: {
          create: expect.objectContaining({ provider: "github", emailVerified: true }),
        },
      }),
    });
  });

  it.each([{ status: "suspended" }, { deletedAt: new Date() }])(
    "refuses a disabled account (%j) signing in by identity",
    async (overrides) => {
      const prisma = prismaMock();
      prisma.userIdentity.findUnique.mockResolvedValue({ user: userRow(overrides) });
      await expect(
        new UsersService(prisma as never).resolveOAuthUser(profile),
      ).rejects.toBeInstanceOf(AccountDisabledError);
    },
  );

  it("retries once when two sign-ins race to create the same account", async () => {
    const { Prisma } = await import("@prisma/client");
    const prisma = prismaMock();
    prisma.userIdentity.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user: userRow() });
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }),
    );
    const service = new UsersService(prisma as never);
    await expect(service.resolveOAuthUser(profile)).resolves.toMatchObject({ id: "u1" });
  });
});

describe("UsersService.linkIdentity", () => {
  it("attaches a new provider account to the signed-in user", async () => {
    const prisma = prismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());
    prisma.userIdentity.findUnique.mockResolvedValue(null);
    await new UsersService(prisma as never).linkIdentity("u1", profile);
    expect(prisma.userIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u1", provider: "github", providerUserId: "42" }),
    });
  });

  it("is idempotent for the same user and refuses another user's provider account", async () => {
    const prisma = prismaMock();
    prisma.user.findUnique.mockResolvedValue(userRow());
    const service = new UsersService(prisma as never);
    prisma.userIdentity.findUnique.mockResolvedValue({ userId: "u1" });
    await expect(service.linkIdentity("u1", profile)).resolves.toBeUndefined();
    prisma.userIdentity.findUnique.mockResolvedValue({ userId: "someone-else" });
    await expect(service.linkIdentity("u1", profile)).rejects.toBeInstanceOf(IdentityInUseError);
    expect(prisma.userIdentity.create).not.toHaveBeenCalled();
  });

  it("refuses a disabled user and maps a creation race to identity_in_use", async () => {
    const prisma = prismaMock();
    const service = new UsersService(prisma as never);
    prisma.user.findUnique.mockResolvedValue(userRow({ status: "suspended" }));
    await expect(service.linkIdentity("u1", profile)).rejects.toBeInstanceOf(AccountDisabledError);

    const { Prisma } = await import("@prisma/client");
    prisma.user.findUnique.mockResolvedValue(userRow());
    prisma.userIdentity.findUnique.mockResolvedValue(null);
    prisma.userIdentity.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "x" }),
    );
    await expect(service.linkIdentity("u1", profile)).rejects.toBeInstanceOf(IdentityInUseError);
  });
});

describe("UsersService sessions", () => {
  it("stores only a hash of the session token", async () => {
    const prisma = prismaMock();
    const service = new UsersService(prisma as never);
    const { token, expiresAt } = await service.createSession("u1", "UA");
    const data = prisma.tx.userSession.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(data)).not.toContain(token);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a session for a user suspended or deleted while sign-in was in flight", async () => {
    for (const user of [
      { status: "suspended", deletedAt: null },
      { status: "active", deletedAt: new Date() },
      null,
    ]) {
      const prisma = prismaMock();
      prisma.tx.user.findUnique.mockResolvedValueOnce(user);
      await expect(
        new UsersService(prisma as never).createSession("u1", "UA"),
      ).rejects.toBeInstanceOf(AccountDisabledError);
      expect(prisma.tx.userSession.create).not.toHaveBeenCalled();
      // Re-checked under the per-user lock the admin's suspend/delete also holds.
      expect(prisma.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.tx.user.findUnique.mock.invocationCallOrder[0],
      );
    }
  });

  it.each([
    ["unknown", null],
    ["revoked", { revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }],
    ["expired", { revokedAt: null, expiresAt: new Date(Date.now() - 1) }],
    [
      "owned by a suspended user",
      {
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: userRow({ status: "suspended" }),
      },
    ],
  ])("rejects a session that is %s", async (_name, session) => {
    const prisma = prismaMock();
    prisma.userSession.findUnique.mockResolvedValue(
      session ? { id: "s", lastSeenAt: null, user: userRow(), ...session } : null,
    );
    await expect(new UsersService(prisma as never).validateSession("t")).resolves.toBeNull();
  });

  it("accepts a live session and debounces last_seen_at writes", async () => {
    const prisma = prismaMock();
    const live = {
      id: "s",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: userRow(),
    };
    prisma.userSession.findUnique
      .mockResolvedValueOnce({ ...live, lastSeenAt: null })
      .mockResolvedValueOnce({ ...live, lastSeenAt: new Date() });
    const service = new UsersService(prisma as never);
    await expect(service.validateSession("t")).resolves.toMatchObject({ id: "u1" });
    await expect(service.validateSession("t")).resolves.toMatchObject({ id: "u1" });
    expect(prisma.userSession.update).toHaveBeenCalledTimes(1);
  });

  it("revokes one session or all of a user's sessions", async () => {
    const prisma = prismaMock();
    const service = new UsersService(prisma as never);
    await service.revokeSession("t");
    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: expect.any(String), revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    await expect(service.revokeAllSessions("u1")).resolves.toBe(2);
  });
});
