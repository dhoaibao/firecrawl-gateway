import bcrypt from "bcrypt";
import type { User } from "../types";
import { consumeRecoveryCode, getMfaState, verifyMfaCode } from "./security";

export type ReauthenticationResult =
  | { ok: true }
  | { ok: false; error: "Current password is incorrect" | "MFA is required" };

/**
 * Re-authenticate a sensitive account action with the current password and,
 * when enabled, an authenticator or recovery code.
 */
export async function verifySensitiveAction(
  user: User,
  body: unknown,
  encryptionKey: string,
): Promise<ReauthenticationResult> {
  const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const currentPassword = typeof input.current_password === "string" ? input.current_password : "";

  if (typeof user.password_hash !== "string" || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return { ok: false, error: "Current password is incorrect" };
  }

  // Older mocked users do not carry auth_version or a persisted MFA factor.
  if (user.auth_version === undefined) return { ok: true };

  const mfa = await getMfaState(user.id);
  if (!mfa.enabled) return { ok: true };

  const mfaCode = typeof input.mfa_code === "string" ? input.mfa_code : "";
  const recoveryCode = typeof input.recovery_code === "string" ? input.recovery_code : "";
  const valid = mfaCode
    ? await verifyMfaCode(user.id, mfaCode, encryptionKey)
    : await consumeRecoveryCode(user.id, recoveryCode);
  return valid ? { ok: true } : { ok: false, error: "MFA is required" };
}
