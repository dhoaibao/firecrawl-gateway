import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateUser,
  blockUser,
  countAdmins,
  countUsers,
  deleteUserSafely,
  getUserByEmail,
  getUserById,
  listUsers,
  suspendUser,
  updateUser,
} from "./service";

const state = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  delete: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  withOperatorTransaction: vi.fn(),
}));
const mockResumeAccountEntitlementsWithClient = vi.hoisted(() => vi.fn());
const mockSuspendAccountEntitlementsWithClient = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  asDatabaseClient: (tx: unknown) => tx,
}));
vi.mock("../infrastructure/database", () => ({
  withOperatorTransaction: state.withOperatorTransaction,
}));
vi.mock("../quota/service", () => ({
  resumeAccountEntitlementsWithClient: mockResumeAccountEntitlementsWithClient,
  suspendAccountEntitlementsWithClient: mockSuspendAccountEntitlementsWithClient,
}));

function userRow(status: string, suspendedUntil: Date | null) {
  return {
    id: "user-1",
    email: "user@example.com",
    normalizedEmail: "user@example.com",
    name: "Test User",
    passwordHash: "hash",
    isAdmin: false,
    platformRole: "user",
    status,
    suspendedUntil,
    emailVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
    authVersion: 1,
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    memberships: [{ accountId: "personal:user-1" }],
  };
}

describe("user reactivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.withOperatorTransaction.mockImplementation(async (fn) => fn({
      user: {
        findUnique: state.findUnique,
        findMany: state.findMany,
        update: state.update,
        count: state.count,
        delete: state.delete,
      },
      $queryRaw: state.queryRaw,
      $executeRaw: state.executeRaw,
    }));
  });

  it("resumes quota entitlements in the same transaction as expired user reactivation", async () => {
    state.findUnique.mockResolvedValue(userRow("suspended", new Date("2026-01-01T00:00:00.000Z")));
    state.update.mockResolvedValue(userRow("active", null));

    const user = await getUserByEmail("user@example.com");

    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(expect.anything(), "personal:user-1");
    expect(user).toMatchObject({ id: "user-1", status: "active", suspended_until: null });
  });

  it("also resumes quota during session-deserialization user lookup", async () => {
    state.findUnique.mockResolvedValue(userRow("suspended", new Date("2026-01-01T00:00:00.000Z")));
    state.update.mockResolvedValue(userRow("active", null));

    await getUserById("user-1");

    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(expect.anything(), "personal:user-1");
  });

  it("atomically activates an admin-restored user with quota", async () => {
    state.update.mockResolvedValue(userRow("active", null));

    const user = await activateUser("user-1");

    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(expect.anything(), "personal:user-1");
    expect(user?.status).toBe("active");
  });

  it("does not expose a half-reactivated user when quota resume fails", async () => {
    state.findUnique.mockResolvedValue(userRow("suspended", new Date("2026-01-01T00:00:00.000Z")));
    state.update.mockResolvedValue(userRow("active", null));
    mockResumeAccountEntitlementsWithClient.mockRejectedValueOnce(new Error("quota unavailable"));

    await expect(getUserByEmail("user@example.com")).rejects.toThrow("quota unavailable");
  });
});

describe("administrative user boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.withOperatorTransaction.mockImplementation(async (fn) => fn({
      user: {
        findUnique: state.findUnique,
        findMany: state.findMany,
        update: state.update,
        count: state.count,
        delete: state.delete,
      },
      $queryRaw: state.queryRaw,
      $executeRaw: state.executeRaw,
    }));
  });

  it("runs administrative reads and writes through the operator transaction", async () => {
    state.findMany.mockResolvedValue([userRow("active", null)]);
    state.update.mockResolvedValue(userRow("active", null));
    state.count.mockResolvedValue(1);
    state.queryRaw.mockResolvedValue([{ id: "user-1", is_admin: false }]);
    state.delete.mockResolvedValue(userRow("active", null));

    await listUsers();
    await updateUser("user-1", { name: "Updated User" });
    await suspendUser("user-1", 60_000);
    await blockUser("user-1");
    await deleteUserSafely("user-1");
    await countUsers();
    await countAdmins();

    expect(state.withOperatorTransaction).toHaveBeenCalledTimes(7);
    expect(state.withOperatorTransaction).toHaveBeenCalledWith(expect.any(Function));
    expect(mockSuspendAccountEntitlementsWithClient).toHaveBeenCalledTimes(2);
  });

  it("syncs quota in the same transaction for generic status updates", async () => {
    state.update.mockResolvedValue(userRow("active", null));

    await updateUser("user-1", { status: "suspended" });
    await updateUser("user-1", { status: "active" });

    expect(mockSuspendAccountEntitlementsWithClient).toHaveBeenCalledWith(expect.anything(), "personal:user-1");
    expect(mockResumeAccountEntitlementsWithClient).toHaveBeenCalledWith(expect.anything(), "personal:user-1");
  });
});
