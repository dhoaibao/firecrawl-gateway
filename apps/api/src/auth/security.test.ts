import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
const mockVerify = vi.hoisted(() => vi.fn());

vi.mock("../db", () => ({
  withOperatorTransaction: (callback: (client: { query: typeof mockQuery }) => unknown) => callback({ query: mockQuery }),
}));

vi.mock("otplib", () => ({
  generateSecret: vi.fn(() => "replacement-secret"),
  generateURI: vi.fn(() => "otpauth://replacement"),
  verify: mockVerify,
}));

vi.mock("./crypto", () => ({
  decryptAuthValue: vi.fn(() => "totp-secret"),
  encryptAuthValue: vi.fn(() => "encrypted-secret"),
}));

import { beginMfaSetup, verifyMfaCode } from "./security";

describe("verifyMfaCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stages a replacement secret without disabling the active factor", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await beginMfaSetup("user-1", "user@example.com", "a".repeat(64));

    const [query] = mockQuery.mock.calls[0] as [string];
    expect(query).toContain("pending_secret_encrypted = EXCLUDED.secret_encrypted");
    expect(query).not.toContain("enabled_at = NULL");
  });

  it("records the enrollment TOTP step and rejects its replay", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ secret_encrypted: "encrypted" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ secret_encrypted: "encrypted" }] })
      .mockResolvedValueOnce({ rowCount: 0 });
    mockVerify.mockResolvedValue({ valid: true, timeStep: 12345 });

    await expect(verifyMfaCode("user-1", "123456", "a".repeat(64), true)).resolves.toBe(true);
    await expect(verifyMfaCode("user-1", "123456", "a".repeat(64))).resolves.toBe(false);

    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("last_used_step = $2"),
      ["user-1", 12345],
    );
  });
});
