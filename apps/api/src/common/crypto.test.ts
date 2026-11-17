import { describe, expect, it } from "vitest";
import {
  decryptSettingValue,
  encryptSettingValue,
  generateEncryptionKey,
  safeEqualStrings,
} from "./crypto";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY = "f".repeat(64);

describe("setting value encryption", () => {
  it("round-trips a value, including non-ASCII text", () => {
    const secret = JSON.stringify(["fc-key-1", "khóa-2"]);
    const encrypted = encryptSettingValue(secret, KEY);

    expect(encrypted.startsWith("enc:v1:")).toBe(true);
    expect(encrypted).not.toContain("fc-key-1");
    expect(decryptSettingValue(encrypted, KEY)).toEqual({ value: secret, encrypted: true });
  });

  it("uses a fresh IV, so equal plaintexts encrypt differently", () => {
    expect(encryptSettingValue("same", KEY)).not.toBe(encryptSettingValue("same", KEY));
  });

  it("passes legacy plaintext through and flags it as not encrypted", () => {
    expect(decryptSettingValue('["fc-key"]', KEY)).toEqual({
      value: '["fc-key"]',
      encrypted: false,
    });
  });

  it("rejects a wrong key and a tampered ciphertext", () => {
    const encrypted = encryptSettingValue("secret", KEY);
    const parts = encrypted.split(":");
    const tampered = [...parts.slice(0, 4), `${parts[4].slice(0, -2)}AA`].join(":");

    expect(() => decryptSettingValue(encrypted, OTHER_KEY)).toThrow();
    expect(() => decryptSettingValue(tampered, KEY)).toThrow();
  });

  it.each([0, 4, 12, 15, 17])("rejects an authentication tag of %i bytes", (length) => {
    const parts = encryptSettingValue("secret", KEY).split(":");
    const tag = Buffer.from(parts[3], "base64url");
    const resized = length <= tag.length ? tag.subarray(0, length) : Buffer.concat([tag, tag]);
    const forged = [
      ...parts.slice(0, 3),
      resized.subarray(0, length).toString("base64url"),
      parts[4],
    ].join(":");

    expect(() => decryptSettingValue(forged, KEY)).toThrow(/Invalid encrypted/);
  });

  it("rejects malformed encrypted values and malformed keys", () => {
    expect(() => decryptSettingValue("enc:v1:onlythree", KEY)).toThrow(/Invalid encrypted/);
    expect(() => encryptSettingValue("x", "short")).toThrow(/64-character hex/);
    expect(() => decryptSettingValue(encryptSettingValue("x", KEY), "zz".repeat(32))).toThrow(
      /64-character hex/,
    );
  });
});

describe("safeEqualStrings", () => {
  it("is true only for equal strings", () => {
    expect(safeEqualStrings("Bearer secret", "Bearer secret")).toBe(true);
    expect(safeEqualStrings("", "")).toBe(true);
    expect(safeEqualStrings("Bearer secret", "Bearer secreT")).toBe(false);
    expect(safeEqualStrings("Bearer secret", "Bearer secret ")).toBe(false);
    expect(safeEqualStrings("short", "a much longer value")).toBe(false);
    expect(safeEqualStrings("value", "")).toBe(false);
  });
});

describe("generateEncryptionKey", () => {
  it("returns a random 64-character hex key accepted by the cipher", () => {
    const key = generateEncryptionKey();

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(generateEncryptionKey());
    expect(decryptSettingValue(encryptSettingValue("v", key), key).value).toBe("v");
  });
});
