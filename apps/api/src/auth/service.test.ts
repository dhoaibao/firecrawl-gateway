import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  withOperatorTransaction: vi.fn(),
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  tokenFindFirst: vi.fn(),
  tokenUpdateMany: vi.fn(),
  tokenUpdate: vi.fn(),
  tokenCreate: vi.fn(),
  securityCreate: vi.fn(),
  sessionUpdateMany: vi.fn(),
}));
const mockQueueEmail = vi.hoisted(() => vi.fn());
const mockAdmitAccountWithClient = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  asDatabaseClient: (tx: unknown) => tx,
}));
vi.mock("../infrastructure/database", () => ({
  withOperatorTransaction: state.withOperatorTransaction,
}));
vi.mock("./email", () => ({
  queueEmail: mockQueueEmail,
}));
vi.mock("../quota/service", () => ({
  admitAccountWithClient: mockAdmitAccountWithClient,
}));

import { requestEmailChange, consumeEmailVerification } from "./service";

function setupTransaction() {
  state.withOperatorTransaction.mockImplementation(async (callback) => callback({
    user: { findFirst: state.userFindFirst, findUnique: state.userFindUnique, update: state.userUpdate },
    authToken: { findFirst: state.tokenFindFirst, updateMany: state.tokenUpdateMany, update: state.tokenUpdate, create: state.tokenCreate },
    securityEvent: { create: state.securityCreate },
    authSession: { updateMany: state.sessionUpdateMany },
  }));
}

describe("requestEmailChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTransaction();
    state.userFindFirst.mockResolvedValue(null);
    state.userFindUnique.mockResolvedValue({ email: "old@example.com" });
    state.tokenFindFirst.mockResolvedValue({ id: "token-existing" });
    state.tokenUpdate.mockResolvedValue({});
    state.tokenUpdateMany.mockResolvedValue({ count: 1 });
    state.tokenCreate.mockResolvedValue({});
    mockQueueEmail.mockResolvedValue(undefined);
  });

  it("atomically replaces an outstanding email-change token", async () => {
    await requestEmailChange({
      userId: "user-1",
      email: "new@example.com",
      encryptionKey: "a".repeat(64),
      baseUrl: "https://gateway.example.com",
    });

    expect(state.tokenFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1", purpose: "email_change", consumedAt: null },
    }));
    expect(state.tokenUpdate).toHaveBeenCalled();
    expect(mockQueueEmail).toHaveBeenCalledOnce();
  });
});

describe("consumeEmailVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTransaction();
    mockAdmitAccountWithClient.mockResolvedValue({ status: "enrolled" });
    state.tokenUpdateMany.mockResolvedValue({ count: 1 });
    state.userUpdate.mockResolvedValue({});
    state.securityCreate.mockResolvedValue({});
    state.sessionUpdateMany.mockResolvedValue({ count: 1 });
  });

  function verificationQueries() {
    state.tokenFindFirst.mockResolvedValue({ id: "token-1", userId: "user-1", purpose: "email_verification", metadata: {} });
  }

  it("admits the verified personal account inside the verification transaction", async () => {
    verificationQueries();
    const verified = await consumeEmailVerification("token-1");

    expect(verified).toBe(true);
    expect(mockAdmitAccountWithClient).toHaveBeenCalledTimes(1);
    expect(mockAdmitAccountWithClient).toHaveBeenCalledWith(expect.anything(), "personal:user-1");
  });

  it("never admits for email-change verifications", async () => {
    state.tokenFindFirst.mockResolvedValue({ id: "token-1", userId: "user-1", purpose: "email_change", metadata: { email: "new@example.com" } });

    await consumeEmailVerification("token-1");
    expect(mockAdmitAccountWithClient).not.toHaveBeenCalled();
    expect(state.sessionUpdateMany).toHaveBeenCalled();
  });

  it("propagates admission failures so the transaction rolls back and the token stays retryable", async () => {
    verificationQueries();
    mockAdmitAccountWithClient.mockRejectedValueOnce(new Error("admission backend unavailable"));

    await expect(consumeEmailVerification("token-1")).rejects.toThrow("admission backend unavailable");
    expect(mockAdmitAccountWithClient).toHaveBeenCalledTimes(1);
  });
});
