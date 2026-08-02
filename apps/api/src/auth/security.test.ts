import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  withOperatorTransaction: vi.fn(),
}));
const mockVerify = vi.hoisted(() => vi.fn());

vi.mock("../infrastructure/database", () => ({
  withOperatorTransaction: state.withOperatorTransaction,
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
    state.upsert.mockResolvedValue({});
    state.update.mockResolvedValue({});
    state.withOperatorTransaction.mockImplementation(async (callback) => callback({
      mfaFactor: { upsert: state.upsert, findUnique: state.findUnique, update: state.update },
    }));
  });

  it("stages a replacement secret without disabling the active factor", async () => {
    await beginMfaSetup("user-1", "user@example.com", "a".repeat(64));

    expect(state.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1" },
      update: expect.objectContaining({ pendingSecretEncrypted: "encrypted-secret" }),
    }));
    expect(state.upsert.mock.calls[0][0].update).not.toHaveProperty("enabledAt", null);
  });

  it("records the enrollment TOTP step and rejects its replay", async () => {
    state.findUnique
      .mockResolvedValueOnce({ secretEncrypted: "encrypted", pendingSecretEncrypted: null })
      .mockResolvedValueOnce({ pendingSecretEncrypted: "encrypted", secretEncrypted: "old", lastUsedStep: null, enabledAt: null })
      .mockResolvedValueOnce({ secretEncrypted: "encrypted", pendingSecretEncrypted: null })
      .mockResolvedValueOnce({ pendingSecretEncrypted: null, secretEncrypted: "encrypted", lastUsedStep: BigInt(12345), enabledAt: new Date() });
    mockVerify.mockResolvedValue({ valid: true, timeStep: 12345 });

    await expect(verifyMfaCode("user-1", "123456", "a".repeat(64), true)).resolves.toBe(true);
    await expect(verifyMfaCode("user-1", "123456", "a".repeat(64))).resolves.toBe(false);

    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1" },
      data: expect.objectContaining({ lastUsedStep: BigInt(12345) }),
    }));
  });
});
