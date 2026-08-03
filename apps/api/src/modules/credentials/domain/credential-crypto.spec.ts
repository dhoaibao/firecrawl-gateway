import { describe, expect, it } from "vitest";
import { decryptProviderCredential, encryptProviderCredential, maskCredential } from "./credential-crypto";

const key = "a".repeat(64);
const context = { purpose: "firecrawl_cloud" as const, ownerId: "account-a", sourceId: "account:account-a:credential-a", keyVersion: 1 };

describe("provider credential crypto", () => {
  it("round trips with authenticated context", () => {
    const encrypted = encryptProviderCredential("fc-secret-value", key, context);
    expect(decryptProviderCredential(encrypted, key, context)).toBe("fc-secret-value");
  });

  it("rejects ciphertext replayed for another owner", () => {
    const encrypted = encryptProviderCredential("fc-secret-value", key, context);
    expect(() => decryptProviderCredential(encrypted, key, { ...context, ownerId: "account-b" })).toThrow();
  });

  it("only exposes bounded masks", () => {
    expect(maskCredential("short-value")).toEqual({ prefix: "shor", suffix: "" });
    expect(maskCredential("1234567890123456")).toEqual({ prefix: "12345678", suffix: "3456" });
  });
});
