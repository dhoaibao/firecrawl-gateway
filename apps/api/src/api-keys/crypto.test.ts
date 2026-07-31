import { describe, expect, it, afterEach } from "vitest";
import { decryptApiKey, encryptApiKey } from "./crypto";

const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("API key encryption", () => {
  afterEach(() => {
    delete process.env.FIRECRAWL_KEYS_ENCRYPTION_KEY;
  });

  it("encrypts retained keys at rest and decrypts them for authorized responses", () => {
    process.env.FIRECRAWL_KEYS_ENCRYPTION_KEY = encryptionKey;
    const encrypted = encryptApiKey("fc_test_key");

    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain("fc_test_key");
    expect(decryptApiKey(encrypted)).toBe("fc_test_key");
  });
});
