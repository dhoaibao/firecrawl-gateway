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
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("Provider credential encryption key must be a 64-character hex string");
  }
  return Buffer.from(key, "hex");
}

function authenticatedData(context: CredentialContext): Buffer {
  return Buffer.from(JSON.stringify({
    purpose: context.purpose,
    ownerId: context.ownerId,
    sourceId: context.sourceId,
    keyVersion: context.keyVersion,
  }), "utf8");
}

/** Encrypt a provider secret so that it cannot be replayed for another owner, purpose, or source. */
export function encryptProviderCredential(value: string, key: string, context: CredentialContext): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  cipher.setAAD(authenticatedData(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, String(context.keyVersion), iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

/**
 * Decrypts only the current versioned format. Legacy settings use their dedicated
 * reader during the explicit conversion window and are never treated as provider
 * credentials.
 */
export function decryptProviderCredential(value: string, key: string, context: CredentialContext): string {
  const parts = value.split(":");
  if (parts.length !== 6 || parts[0] !== "credential" || parts[1] !== "v2") {
    throw new Error("Invalid provider credential ciphertext");
  }
  const [, , storedVersion, ivEncoded, tagEncoded, ciphertextEncoded] = parts;
  if (Number(storedVersion) !== context.keyVersion) {
    throw new Error("Provider credential key version does not match its encryption context");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(key), Buffer.from(ivEncoded, "base64url"));
  decipher.setAAD(authenticatedData(context));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskCredential(value: string): { prefix: string; suffix: string } {
  // Short values expose at most a four-character prefix; never reveal enough
  // pieces to reconstruct the complete credential.
  if (value.length <= 12) return { prefix: value.slice(0, 4), suffix: "" };
  return { prefix: value.slice(0, 8), suffix: value.slice(-4) };
}
