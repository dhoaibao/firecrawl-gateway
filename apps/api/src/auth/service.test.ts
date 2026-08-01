import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockQueueEmail = vi.hoisted(() => vi.fn());
const mockAdmitAccountWithClient = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  withOperatorTransaction: (callback: (client: { query: typeof mockQuery }) => unknown) => callback({ query: mockQuery }),
}));

vi.mock("./email", () => ({
  queueEmail: mockQueueEmail,
}));

vi.mock("../quota/service", () => ({
  admitAccountWithClient: mockAdmitAccountWithClient,
}));

import { requestEmailChange, consumeEmailVerification } from "./service";

describe("requestEmailChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ email: "old@example.com" }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    mockQueueEmail.mockResolvedValue(undefined);
  });

  it("atomically replaces an outstanding email-change token", async () => {
    await requestEmailChange({
      userId: "user-1",
      email: "new@example.com",
      encryptionKey: "a".repeat(64),
      baseUrl: "https://gateway.example.com",
    });

    expect(mockQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("ON CONFLICT (user_id, purpose) WHERE consumed_at IS NULL"),
      expect.any(Array),
    );
    expect(mockQueueEmail).toHaveBeenCalledOnce();
  });
});

describe("consumeEmailVerification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdmitAccountWithClient.mockResolvedValue({ status: "enrolled" });
  });

  function verificationQueries() {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ user_id: "user-1", purpose: "email_verification", metadata: {} }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // token consumption
      .mockResolvedValueOnce({ rowCount: 1 }) // email_verified_at
      .mockResolvedValueOnce({ rowCount: 1 }); // security event
  }

  it("admits the verified personal account inside the verification transaction", async () => {
    verificationQueries();
    const verified = await consumeEmailVerification("token-1");

    expect(verified).toBe(true);
    expect(mockAdmitAccountWithClient).toHaveBeenCalledTimes(1);
    expect(mockAdmitAccountWithClient).toHaveBeenCalledWith(expect.anything(), "personal:user-1");
  });

  it("never admits for email-change verifications", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ user_id: "user-1", purpose: "email_change", metadata: { email: "new@example.com" } }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await consumeEmailVerification("token-1");
    expect(mockAdmitAccountWithClient).not.toHaveBeenCalled();
  });

  it("propagates admission failures so the transaction rolls back and the token stays retryable", async () => {
    verificationQueries();
    mockAdmitAccountWithClient.mockRejectedValueOnce(new Error("admission backend unavailable"));

    await expect(consumeEmailVerification("token-1")).rejects.toThrow("admission backend unavailable");
    // The token was never committed as consumed; the caller (and the real
    // operator transaction) rolls the verification back.
    expect(mockAdmitAccountWithClient).toHaveBeenCalledTimes(1);
  });
});
