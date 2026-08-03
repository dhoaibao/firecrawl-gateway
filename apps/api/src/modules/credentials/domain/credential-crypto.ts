import crypto from "node:crypto";

const PREFIX = "credential:v2";
const IV_BYTES = 12;

export interface CredentialContext {
  purpose: "firecrawl_cloud" | "self_hosted_upstream";
  ownerId: string;
  sourceId: string;
  keyVersion: number;
}

function encryptionKey(key: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error("Provider credential encryption key must be a 64-character hex string");
  return Buffer.from(key, "hex");
}

function authenticatedData(context: CredentialContext): Buffer {
  return Buffer.from(JSON.stringify({ purpose: context.purpose, ownerId: context.ownerId, sourceId: context.sourceId, keyVersion: context.keyVersion }), "utf8");
}

export function encryptProviderCredential(value: string, key: string, context: CredentialContext): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  cipher.setAAD(authenticatedData(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [PREFIX, String(context.keyVersion), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptProviderCredential(value: string, key: string, context: CredentialContext): string {
  const parts = value.split(":");
  if (parts.length !== 6 || parts[0] !== "credential" || parts[1] !== "v2") throw new Error("Invalid provider credential ciphertext");
  const [, , storedVersion, iv, tag, ciphertext] = parts;
  if (Number(storedVersion) !== context.keyVersion) throw new Error("Provider credential key version does not match its encryption context");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(key), Buffer.from(iv, "base64url"));
  decipher.setAAD(authenticatedData(context));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export function maskCredential(value: string): { prefix: string; suffix: string } {
  return value.length <= 12 ? { prefix: value.slice(0, 4), suffix: "" } : { prefix: value.slice(0, 8), suffix: value.slice(-4) };
}
