import crypto from "node:crypto";

function keyFromHex(key: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("Auth encryption key must be 32-byte hex");
  return Buffer.from(key, "hex");
}

export function encryptAuthValue(value: string, key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFromHex(key), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptAuthValue(value: string, key: string): string {
  const [ivText, tagText, encryptedText] = value.split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Invalid encrypted auth value");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFromHex(key), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}
