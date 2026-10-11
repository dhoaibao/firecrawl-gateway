import { describe, expect, it, vi } from "vitest";
import { encryptSettingValue } from "../common/crypto";
import {
  loadCloudApiKeys,
  loadCloudKeyEntries,
  parseCloudKeyEntries,
  serializeCloudKeyEntries,
} from "./cloud-keys";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function record(value: string) {
  return { key: "firecrawl_api_keys", value, updated_at: "2026-01-01T00:00:00.000Z" };
}

describe("parseCloudKeyEntries", () => {
  it("treats strings as cloud keys and drops malformed items and non-arrays", () => {
    expect(parseCloudKeyEntries('["fc-a","",7,null,"fc-b"]')).toEqual([
      { key: "fc-a", role: "cloud" },
      { key: "fc-b", role: "cloud" },
    ]);
    expect(parseCloudKeyEntries('{"keys":["fc-a"]}')).toEqual([]);
    expect(parseCloudKeyEntries("[]")).toEqual([]);
  });

  it("reads explicit roles and defaults an unknown role to cloud", () => {
    expect(
      parseCloudKeyEntries(
        '["fc-a",{"key":"fc-b","role":"fallback"},{"key":"fc-c","role":"bogus"},{"role":"fallback"}]',
      ),
    ).toEqual([
      { key: "fc-a", role: "cloud" },
      { key: "fc-b", role: "fallback" },
      { key: "fc-c", role: "cloud" },
    ]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseCloudKeyEntries("not json")).toThrow();
  });
});

describe("serializeCloudKeyEntries", () => {
  it("keeps cloud keys as plain strings so an older reader still sees them", () => {
    const entries = [
      { key: "fc-a", role: "cloud" as const },
      { key: "fc-b", role: "fallback" as const },
    ];
    expect(serializeCloudKeyEntries(entries)).toBe('["fc-a",{"key":"fc-b","role":"fallback"}]');
    expect(parseCloudKeyEntries(serializeCloudKeyEntries(entries))).toEqual(entries);
  });
});

describe("loadCloudKeyEntries", () => {
  it("returns the role of each stored key", async () => {
    const settings = { replaceSettingIfUnchanged: vi.fn() };
    const value = encryptSettingValue('["fc-a",{"key":"fc-b","role":"fallback"}]', ENCRYPTION_KEY);

    await expect(loadCloudKeyEntries(record(value), ENCRYPTION_KEY, settings)).resolves.toEqual([
      { key: "fc-a", role: "cloud" },
      { key: "fc-b", role: "fallback" },
    ]);
  });
});

describe("loadCloudApiKeys", () => {
  it("decrypts an encrypted record without rewriting it", async () => {
    const settings = { replaceSettingIfUnchanged: vi.fn() };
    const value = encryptSettingValue('["fc-a","fc-b"]', ENCRYPTION_KEY);

    await expect(loadCloudApiKeys(record(value), ENCRYPTION_KEY, settings)).resolves.toEqual([
      "fc-a",
      "fc-b",
    ]);
    expect(settings.replaceSettingIfUnchanged).not.toHaveBeenCalled();
  });

  it("encrypts a legacy plaintext record in place, only while it is unchanged", async () => {
    const settings = { replaceSettingIfUnchanged: vi.fn().mockResolvedValue(true) };

    await expect(loadCloudApiKeys(record('["fc-a"]'), ENCRYPTION_KEY, settings)).resolves.toEqual([
      "fc-a",
    ]);

    expect(settings.replaceSettingIfUnchanged).toHaveBeenCalledWith(
      "firecrawl_api_keys",
      '["fc-a"]',
      expect.stringMatching(/^enc:v1:/),
    );
    expect(settings.replaceSettingIfUnchanged.mock.calls[0][2]).not.toContain("fc-a");
  });

  it("throws when the value cannot be decrypted", async () => {
    const settings = { replaceSettingIfUnchanged: vi.fn() };
    const value = encryptSettingValue('["fc-a"]', "f".repeat(64));

    await expect(loadCloudApiKeys(record(value), ENCRYPTION_KEY, settings)).rejects.toThrow();
    expect(settings.replaceSettingIfUnchanged).not.toHaveBeenCalled();
  });
});
