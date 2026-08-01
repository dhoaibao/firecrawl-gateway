import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockQueueEmail = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  withOperatorTransaction: (callback: (client: { query: typeof mockQuery }) => unknown) => callback({ query: mockQuery }),
}));

vi.mock("./email", () => ({
  queueEmail: mockQueueEmail,
}));

import { requestEmailChange } from "./service";

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
