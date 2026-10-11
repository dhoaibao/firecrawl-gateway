import { decryptSettingValue, encryptSettingValue } from "../common/crypto";
import type { SettingRecord, SettingsService } from "./settings.service";

/** Parses a decrypted `firecrawl_api_keys` value, keeping only non-empty strings. */
export function parseCloudApiKeys(plaintext: string): string[] {
  const parsed = JSON.parse(plaintext) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((key): key is string => typeof key === "string" && key.length > 0)
    : [];
}

/**
 * Reads the Firecrawl Cloud API keys from their stored (encrypted) setting. A
 * legacy plaintext record is encrypted in place, but only while it is unchanged,
 * so a concurrent admin update is never overwritten.
 *
 * Throws when the value cannot be decrypted or parsed; callers decide how to
 * degrade. Never include the thrown message in logs: a JSON parse error can
 * quote the key material.
 */
export async function loadCloudApiKeys(
  record: SettingRecord,
  encryptionKey: string,
  settings: Pick<SettingsService, "replaceSettingIfUnchanged">,
): Promise<string[]> {
  const decrypted = decryptSettingValue(record.value, encryptionKey);
  if (!decrypted.encrypted)
    await settings.replaceSettingIfUnchanged(
      record.key,
      record.value,
      encryptSettingValue(record.value, encryptionKey),
    );
  return parseCloudApiKeys(decrypted.value);
}
