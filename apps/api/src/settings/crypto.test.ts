import { describe, expect, it } from "vitest";
import { decryptSettingValue, encryptSettingValue } from "./crypto";

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("settings encryption", () => {
  it("encrypts and decrypts values without storing plaintext", () => {
    const plaintext = '["fc_cloud_secret"]';
    const encrypted = encryptSettingValue(plaintext, key);

    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSettingValue(encrypted, key)).toEqual({ value: plaintext, encrypted: true });
  });

  it("continues to read legacy plaintext values for migration", () => {
    expect(decryptSettingValue('["fc_legacy_secret"]', key)).toEqual({
      value: '["fc_legacy_secret"]',
      encrypted: false,
    });
  });

  it("rejects a wrong key", () => {
    const encrypted = encryptSettingValue("secret", key);
    const wrongKey = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    expect(() => decryptSettingValue(encrypted, wrongKey)).toThrow();
  });
});
