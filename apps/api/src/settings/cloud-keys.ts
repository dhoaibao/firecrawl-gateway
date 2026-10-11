import { decryptSettingValue, encryptSettingValue } from "../common/crypto";
import type { CloudKeyEntry } from "../common/types";
import type { SettingRecord, SettingsService } from "./settings.service";

/**
 * Parses a decrypted `firecrawl_api_keys` value. A plain string is a `cloud`
 * key; an object carries its own `role`. Anything else is dropped.
 */
export function parseCloudKeyEntries(plaintext: string): CloudKeyEntry[] {
  const parsed = JSON.parse(plaintext) as unknown;
  if (!Array.isArray(parsed)) return [];
  const entries: CloudKeyEntry[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item === "string") {
      if (item) entries.push({ key: item, role: "cloud" });
    } else if (item && typeof item === "object") {
      const { key, role } = item as Record<string, unknown>;
      if (typeof key === "string" && key)
        entries.push({ key, role: role === "fallback" ? "fallback" : "cloud" });
    }
  }
  return entries;
}

/** Cloud-role keys stay plain strings, so an older API version still reads them after a rollback. */
export function serializeCloudKeyEntries(entries: CloudKeyEntry[]): string {
  return JSON.stringify(entries.map((entry) => (entry.role === "cloud" ? entry.key : entry)));
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
export async function loadCloudKeyEntries(
  record: SettingRecord,
  encryptionKey: string,
  settings: Pick<SettingsService, "replaceSettingIfUnchanged">,
): Promise<CloudKeyEntry[]> {
  const decrypted = decryptSettingValue(record.value, encryptionKey);
  if (!decrypted.encrypted)
    await settings.replaceSettingIfUnchanged(
      record.key,
      record.value,
      encryptSettingValue(record.value, encryptionKey),
    );
  return parseCloudKeyEntries(decrypted.value);
}

/** Every configured key regardless of role, for credit refreshes. */
export async function loadCloudApiKeys(
  record: SettingRecord,
  encryptionKey: string,
  settings: Pick<SettingsService, "replaceSettingIfUnchanged">,
): Promise<string[]> {
  const entries = await loadCloudKeyEntries(record, encryptionKey, settings);
  return entries.map((entry) => entry.key);
}
