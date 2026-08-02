import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  initializePrisma: vi.fn(),
  pingPrisma: vi.fn(),
  assertPrismaReady: vi.fn(),
  assertRuntimeRoleReady: vi.fn(),
  assertOperatorRoleReady: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  withAccountTransaction: vi.fn(),
  withOperatorTransaction: vi.fn(),
  withRuntimeTransaction: vi.fn(),
  withUserAccountTransaction: vi.fn(),
}));

vi.mock("../infrastructure/database", () => ({
  initializePrisma: state.initializePrisma,
  pingPrisma: state.pingPrisma,
  assertPrismaReady: state.assertPrismaReady,
  assertRuntimeRoleReady: state.assertRuntimeRoleReady,
  assertOperatorRoleReady: state.assertOperatorRoleReady,
  disconnectPrisma: vi.fn(),
  getPrisma: vi.fn(),
  withAccountTransaction: state.withAccountTransaction,
  withOperatorTransaction: state.withOperatorTransaction,
  withRuntimeTransaction: state.withRuntimeTransaction,
  withUserAccountTransaction: state.withUserAccountTransaction,
}));

import {
  initDatabase,
  normalizePrismaRawResult,
  withAccountTransaction,
  withTransaction,
} from "./index";

function fakeTransaction() {
  return {
    $queryRawUnsafe: state.queryRaw,
    $executeRawUnsafe: state.executeRaw,
  };
}

describe("database transaction primitives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.pingPrisma.mockResolvedValue(true);
    state.assertPrismaReady.mockResolvedValue(undefined);
    state.assertRuntimeRoleReady.mockResolvedValue(undefined);
    state.assertOperatorRoleReady.mockResolvedValue(undefined);
    state.queryRaw.mockResolvedValue([]);
    state.executeRaw.mockResolvedValue(0);
    state.withAccountTransaction.mockImplementation(async (_accountId, fn) => fn(fakeTransaction()));
    state.withOperatorTransaction.mockImplementation(async (fn) => fn(fakeTransaction()));
    state.withRuntimeTransaction.mockImplementation(async (fn) => fn(fakeTransaction()));
  });

  it("initializes Prisma clients and checks schema readiness without applying DDL", async () => {
    await initDatabase("postgresql://example.test/gateway", "postgresql://example.test/operator");

    expect(state.initializePrisma).toHaveBeenCalledWith(
      "postgresql://example.test/gateway",
      "postgresql://example.test/operator",
    );
    expect(state.pingPrisma).toHaveBeenCalled();
    expect(state.assertPrismaReady).toHaveBeenCalled();
    expect(state.assertRuntimeRoleReady).toHaveBeenCalled();
    expect(state.assertOperatorRoleReady).toHaveBeenCalled();
  });

  it("runs account-scoped work through the Prisma transaction adapter", async () => {
    await withAccountTransaction("account-a", async (client) => {
      await client.query("SELECT 1");
    });

    expect(state.withAccountTransaction).toHaveBeenCalledWith("account-a", expect.any(Function));
    expect(state.queryRaw).toHaveBeenCalledWith("SELECT 1");
  });

  it("uses the operator Prisma transaction for operator work", async () => {
    await withTransaction(async (client) => {
      await client.query("SELECT 1");
    }, { operator: true });

    expect(state.withOperatorTransaction).toHaveBeenCalledWith(expect.any(Function));
    expect(state.queryRaw).toHaveBeenCalledWith("SELECT 1");
  });

  it("normalizes safe Prisma BIGINT values recursively", () => {
    expect(normalizePrismaRawResult({ hard_cap: 10n, nested: [2n, { consumed: 3n }] })).toEqual({
      hard_cap: 10,
      nested: [2, { consumed: 3 }],
    });
    expect(() => normalizePrismaRawResult(9007199254740992n)).toThrow("safe integer range");
  });

  it("propagates transaction failures", async () => {
    state.withRuntimeTransaction.mockImplementation(async (fn) => fn(fakeTransaction()));

    await expect(withTransaction(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });
});
