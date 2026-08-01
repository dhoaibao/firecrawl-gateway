import crypto from "node:crypto";

export function createOpaqueToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

export function generateRecoveryCode(): string {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}
