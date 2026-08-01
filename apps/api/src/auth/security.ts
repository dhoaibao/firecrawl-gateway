import crypto from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import { withOperatorTransaction } from "../db";
import { encryptAuthValue, decryptAuthValue } from "./crypto";
import { generateRecoveryCode, hashOpaqueToken, hashRecoveryCode } from "./tokens";

const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export function privacyLabel(value: string | undefined, max = 96): string | null {
  if (!value) return null;
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, max);
}

export async function recordSecurityEvent(input: {
  userId?: string | null;
  type: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await withOperatorTransaction(async (client) => {
    await client.query(
      `INSERT INTO security_events (id, user_id, event_type, ip_label, user_agent_label, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [crypto.randomUUID(), input.userId ?? null, input.type, privacyLabel(input.ip), privacyLabel(input.userAgent), JSON.stringify(input.metadata ?? {})],
    );
  });
}

export async function createSessionRecord(input: {
  sessionId: string;
  userId: string;
  authVersion: number;
  mfaVerified?: boolean;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  await withOperatorTransaction(async (client) => {
    await client.query(
      `INSERT INTO auth_sessions (id, session_id_hash, user_id, auth_version, mfa_verified_at, ip_label, user_agent_label, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [crypto.randomUUID(), hashOpaqueToken(input.sessionId), input.userId, input.authVersion, input.mfaVerified ? new Date() : null, privacyLabel(input.ip), privacyLabel(input.userAgent), new Date(Date.now() + SESSION_IDLE_MS), new Date(Date.now() + SESSION_ABSOLUTE_MS)],
    );
  });
}

export async function validateAndTouchSession(sessionId: string, userId: string, authVersion: number): Promise<boolean> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE auth_sessions
       SET last_seen_at = NOW(), idle_expires_at = NOW() + INTERVAL '8 hours'
       WHERE session_id_hash = $1 AND user_id = $2 AND auth_version = $3 AND revoked_at IS NULL
         AND idle_expires_at > NOW() AND absolute_expires_at > NOW()
       RETURNING id`,
      [hashOpaqueToken(sessionId), userId, authVersion],
    );
    return result.rowCount === 1;
  });
}

export async function sessionHasMfaVerification(sessionId: string, userId: string, authVersion: number): Promise<boolean> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query(
      `SELECT id FROM auth_sessions
       WHERE session_id_hash = $1 AND user_id = $2 AND auth_version = $3 AND mfa_verified_at IS NOT NULL
         AND revoked_at IS NULL AND idle_expires_at > NOW() AND absolute_expires_at > NOW()`,
      [hashOpaqueToken(sessionId), userId, authVersion],
    );
    return result.rowCount === 1;
  });
}

export async function markSessionMfaVerified(sessionId: string, userId: string, authVersion: number): Promise<void> {
  await withOperatorTransaction((client) => client.query(
    `UPDATE auth_sessions SET mfa_verified_at = NOW()
     WHERE session_id_hash = $1 AND user_id = $2 AND auth_version = $3 AND revoked_at IS NULL`,
    [hashOpaqueToken(sessionId), userId, authVersion],
  ).then(() => undefined));
}

export async function revokeSession(sessionId: string): Promise<void> {
  await withOperatorTransaction((client) => client.query(
    "UPDATE auth_sessions SET revoked_at = NOW() WHERE session_id_hash = $1 AND revoked_at IS NULL",
    [hashOpaqueToken(sessionId)],
  ).then(() => undefined));
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await withOperatorTransaction((client) => client.query(
    "UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  ).then(() => undefined));
}

export async function listSessions(userId: string) {
  return withOperatorTransaction(async (client) => {
    const result = await client.query(
      `SELECT id, created_at, last_seen_at, ip_label, user_agent_label, revoked_at
       FROM auth_sessions WHERE user_id = $1 ORDER BY last_seen_at DESC`,
      [userId],
    );
    return result.rows;
  });
}

export async function getMfaState(userId: string): Promise<{ enabled: boolean; verified: boolean }> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<{ enabled: boolean; verified: boolean }>(
      "SELECT enabled_at IS NOT NULL AS enabled, verified_at IS NOT NULL AS verified FROM mfa_factors WHERE user_id = $1",
      [userId],
    );
    return result.rows[0] ?? { enabled: false, verified: false };
  });
}

export async function beginMfaSetup(userId: string, email: string, encryptionKey: string) {
  const secret = generateSecret();
  await withOperatorTransaction(async (client) => {
    await client.query(
      `INSERT INTO mfa_factors (id, user_id, secret_encrypted, key_version, verified_at, enabled_at)
       VALUES ($1, $2, $3, 1, NULL, NULL)
       ON CONFLICT (user_id) DO UPDATE SET pending_secret_encrypted = EXCLUDED.secret_encrypted, updated_at = NOW()`,
      [crypto.randomUUID(), userId, encryptAuthValue(secret, encryptionKey)],
    );
  });
  return { secret, uri: generateURI({ issuer: "Firecrawl Gateway", label: email, secret }) };
}

async function getSecret(userId: string, encryptionKey: string, pending = false): Promise<string | null> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<{ secret_encrypted: string }>(
      pending
        ? "SELECT COALESCE(pending_secret_encrypted, secret_encrypted) AS secret_encrypted FROM mfa_factors WHERE user_id = $1"
        : "SELECT secret_encrypted FROM mfa_factors WHERE user_id = $1",
      [userId],
    );
    return result.rows[0] ? decryptAuthValue(result.rows[0].secret_encrypted, encryptionKey) : null;
  });
}

export async function verifyMfaCode(userId: string, code: string, encryptionKey: string, allowPending = false): Promise<boolean> {
  const secret = await getSecret(userId, encryptionKey, allowPending);
  if (!secret) return false;
  const result = await verify({ secret, token: code.replace(/\s/g, ""), epochTolerance: [30, 0] });
  if (!result.valid || !("timeStep" in result) || typeof result.timeStep !== "number") return false;
  return withOperatorTransaction(async (client) => {
    const update = await client.query(
      allowPending
        ? `UPDATE mfa_factors
           SET secret_encrypted = COALESCE(pending_secret_encrypted, secret_encrypted), pending_secret_encrypted = NULL,
               verified_at = NOW(), enabled_at = NOW(), last_used_step = $2, updated_at = NOW()
           WHERE user_id = $1 AND (
             pending_secret_encrypted IS NOT NULL OR
             (pending_secret_encrypted IS NULL AND enabled_at IS NULL AND (last_used_step IS NULL OR last_used_step < $2))
           ) RETURNING id`
        : "UPDATE mfa_factors SET verified_at = COALESCE(verified_at, NOW()), last_used_step = $2, updated_at = NOW() WHERE user_id = $1 AND enabled_at IS NOT NULL AND (last_used_step IS NULL OR last_used_step < $2) RETURNING id", 
      [userId, result.timeStep],
    );
    return update.rowCount === 1;
  });
}

export async function disableMfa(userId: string): Promise<void> {
  await withOperatorTransaction(async (client) => {
    await client.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM mfa_factors WHERE user_id = $1", [userId]);
    await client.query("INSERT INTO security_events (id, user_id, event_type) VALUES ($1, $2, 'mfa_disabled')", [crypto.randomUUID(), userId]);
  });
}

export async function createRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, generateRecoveryCode);
  await withOperatorTransaction(async (client) => {
    await client.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [userId]);
    for (const code of codes) {
      await client.query(
        "INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)",
        [crypto.randomUUID(), userId, hashRecoveryCode(code)],
      );
    }
  });
  return codes;
}

export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query(
      `UPDATE mfa_recovery_codes SET consumed_at = NOW()
       WHERE id = (SELECT id FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND consumed_at IS NULL FOR UPDATE SKIP LOCKED)
       RETURNING id`,
      [userId, hashRecoveryCode(code)],
    );
    return result.rowCount === 1;
  });
}
