import { describe, expect, it, vi, beforeEach } from "vitest";
import { clearSourceConcurrency, resolveInfrastructureSources, tryAcquireSource } from "./repository";

const state = vi.hoisted(() => ({
  withOperatorTransaction: vi.fn(),
  providerFindMany: vi.fn(),
  sourceFindMany: vi.fn(),
}));

vi.mock("../infrastructure/database", () => ({
  withOperatorTransaction: state.withOperatorTransaction,
}));

const source = { id: "source-a", hardConcurrency: 1 };

describe("source concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.withOperatorTransaction.mockImplementation(async (callback) => callback({
      providerCredential: { findMany: state.providerFindMany },
      infrastructureSource: { findMany: state.sourceFindMany },
    }));
    state.providerFindMany.mockResolvedValue([]);
    state.sourceFindMany.mockResolvedValue([]);
  });

  it("releases capacity exactly once", () => {
    clearSourceConcurrency();
    const release = tryAcquireSource(source);
    expect(release).toBeTypeOf("function");
    expect(tryAcquireSource(source)).toBeNull();
    release?.();
    release?.();
    expect(tryAcquireSource(source)).toBeTypeOf("function");
  });

  it("does not resolve a Cloud source after its credential is revoked", async () => {
    state.sourceFindMany.mockResolvedValue([{
      id: "source-a",
      name: "Cloud",
      kind: "cloud",
      status: "active",
      priority: 1,
      baseUrl: "",
      credentialId: "revoked-credential",
      capabilities: [],
      monthlyBudgetCents: null,
      hardConcurrency: 1,
      requestTimeoutMs: 120_000,
      responseBufferMaxBytes: 5_242_880,
      healthStatus: "healthy",
      lastHealthCheckAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      credential: {
        id: "revoked-credential",
        ownerType: "operator",
        accountId: null,
        purpose: "firecrawl_cloud",
        encryptedValue: "encrypted",
        keyVersion: 1,
        status: "revoked",
        supersededAt: null,
      },
    }]);

    const sources = await resolveInfrastructureSources("account-a", "included", "a".repeat(64), "https://cloud.example");

    expect(sources).toEqual([]);
  });
});
