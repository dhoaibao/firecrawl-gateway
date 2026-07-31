import crypto from "node:crypto";

const ENCRYPTION_PREFIX = "enc:v1";
const KEY_BYTES = 32;

function encryptionKey(key: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("FIRECRAWL_KEYS_ENCRYPTION_KEY must be a 64-character hex string");
  }
  return Buffer.from(key, "hex");
}

export function encryptSettingValue(value: string, key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENCRYPTION_PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSettingValue(value: string, key: string): { value: string; encrypted: boolean } {
  if (!value.startsWith(`${ENCRYPTION_PREFIX}:`)) {
    return { value, encrypted: false };
  }

  const parts = value.split(":");
  if (parts.length !== 5) throw new Error("Invalid encrypted Firecrawl API key setting");
  const [, , ivEncoded, tagEncoded, ciphertextEncoded] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(key),
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return { value: plaintext, encrypted: true };
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}
