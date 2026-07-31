import { decryptSettingValue, encryptSettingValue } from "../settings/crypto";

function encryptionKey(): string {
  return process.env.FIRECRAWL_KEYS_ENCRYPTION_KEY ?? "";
}

export function encryptApiKey(key: string): string {
  return encryptSettingValue(key, encryptionKey());
}

export function decryptApiKey(value: string): string {
  return decryptSettingValue(value, encryptionKey()).value;
}
