import { describe, expect, it } from "vitest";
import { decryptProviderCredential, encryptProviderCredential, maskCredential } from "./crypto";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const context = {
  purpose: "firecrawl_cloud" as const,
  ownerId: "account-a",
  sourceId: "account:account-a:credential-a",
  keyVersion: 1,
};

describe("provider credential crypto", () => {
  it("round trips only with the original authenticated context", () => {
    const ciphertext = encryptProviderCredential("fc_provider_secret", key, context);
    expect(decryptProviderCredential(ciphertext, key, context)).toBe("fc_provider_secret");
  });

  it("never exposes a short credential entirely through its mask", () => {
    const masked = maskCredential("secret");
    expect(`${masked.prefix}${masked.suffix}`).not.toBe("secret");
  });

  it("rejects ciphertext moved to a different account, purpose, or source", () => {
    const ciphertext = encryptProviderCredential("fc_provider_secret", key, context);
    expect(() => decryptProviderCredential(ciphertext, key, { ...context, ownerId: "account-b" })).toThrow();
    expect(() => decryptProviderCredential(ciphertext, key, { ...context, sourceId: "source-b" })).toThrow();
    expect(() => decryptProviderCredential(ciphertext, key, { ...context, purpose: "self_hosted_upstream" })).toThrow();
  });
});
