import crypto from "node:crypto";
import { withOperatorTransaction } from "../db";
import { hashPassword } from "./password";
import { createOpaqueToken, hashOpaqueToken } from "./tokens";
import { queueEmail } from "./email";
import { admitAccountWithClient } from "../quota/service";
import type { User } from "../types";

export const GENERIC_AUTH_MESSAGE = "If the account can be processed, you will receive an email shortly.";

function userSelect() {
  return `SELECT u.*, 'personal:' || u.id AS account_id FROM users u`;
}

export async function registerUser(input: {
  email: string;
  name: string;
  password: string;
  encryptionKey: string;
  baseUrl: string;
  ip?: string;
  userAgent?: string;
  isAdmin?: boolean;
}): Promise<User | null> {
  const normalized = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  return withOperatorTransaction(async (client) => {
    const existing = await client.query("SELECT id FROM users WHERE normalized_email = $1", [normalized]);
    if (existing.rowCount) return null;
    const userId = crypto.randomUUID();
    const token = createOpaqueToken();
    const userResult = await client.query<User>(
      `INSERT INTO users (id, email, normalized_email, name, password_hash, is_admin, platform_role, status, email_verified_at, auth_version, suspended_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, 1, NULL) RETURNING *`,
      [userId, input.email.trim(), normalized, input.name.trim(), passwordHash, input.isAdmin === true, input.isAdmin ? "admin" : "user"],
    );
    await client.query("INSERT INTO accounts (id, display_name) VALUES ($1, $2)", [`personal:${userId}`, input.name.trim() || normalized]);
    await client.query("INSERT INTO account_memberships (account_id, user_id, role) VALUES ($1, $2, 'owner')", [`personal:${userId}`, userId]);
    await client.query(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'email_verification', $3, NOW() + INTERVAL '30 minutes')`,
      [crypto.randomUUID(), userId, token.hash],
    );
    await client.query(
      `INSERT INTO security_events (id, user_id, event_type, ip_label, user_agent_label, metadata)
       VALUES ($1, $2, 'registration_requested', $3, $4, '{}'::jsonb)`,
      [crypto.randomUUID(), userId, input.ip ? crypto.createHash("sha256").update(input.ip).digest("hex").slice(0, 96) : null, input.userAgent ? crypto.createHash("sha256").update(input.userAgent).digest("hex").slice(0, 96) : null],
    );
    await queueEmail({
      client, userId, recipient: normalized, kind: "email_verification",
      idempotencyKey: `email-verification:${userId}:${token.hash}`,
      payload: { subject: "Verify your Firecrawl Gateway email", html: `<p>Verify your email by visiting <a href="${input.baseUrl}/admin/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>` },
      encryptionKey: input.encryptionKey,
    });
    return { ...userResult.rows[0], account_id: `personal:${userId}` };
  });
}

export async function requestEmailVerification(input: { email: string; encryptionKey: string; baseUrl: string }): Promise<void> {
  const normalized = input.email.trim().toLowerCase();
  await withOperatorTransaction(async (client) => {
    const result = await client.query<{ id: string; email: string }>(`${userSelect()} WHERE normalized_email = $1 AND email_verified_at IS NULL`, [normalized]);
    const user = result.rows[0];
    if (!user) return;
    const token = createOpaqueToken();
    await client.query("UPDATE auth_tokens SET consumed_at = NOW() WHERE user_id = $1 AND purpose = 'email_verification' AND consumed_at IS NULL", [user.id]);
    await client.query("INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'email_verification', $3, NOW() + INTERVAL '30 minutes')", [crypto.randomUUID(), user.id, token.hash]);
    await queueEmail({
      client, userId: user.id, recipient: user.email, kind: "email_verification", idempotencyKey: `email-verification:${user.id}:${token.hash}`,
      payload: { subject: "Verify your Firecrawl Gateway email", html: `<p>Verify your email by visiting <a href="${input.baseUrl}/admin/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>` }, encryptionKey: input.encryptionKey,
    });
  });
}

export async function requestEmailChange(input: { userId: string; email: string; encryptionKey: string; baseUrl: string }): Promise<void> {
  const normalized = input.email.trim().toLowerCase();
  await withOperatorTransaction(async (client) => {
    const duplicate = await client.query("SELECT id FROM users WHERE normalized_email = $1 AND id <> $2", [normalized, input.userId]);
    if (duplicate.rowCount) throw new Error("Email is already in use");
    const user = await client.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [input.userId]);
    if (!user.rows[0]) return;
    const token = createOpaqueToken();
    await client.query(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, metadata, expires_at)
       VALUES ($1, $2, 'email_change', $3, $4::jsonb, NOW() + INTERVAL '30 minutes')
       ON CONFLICT (user_id, purpose) WHERE consumed_at IS NULL
       DO UPDATE SET token_hash = EXCLUDED.token_hash, metadata = EXCLUDED.metadata, expires_at = EXCLUDED.expires_at, created_at = NOW()`,
      [crypto.randomUUID(), input.userId, token.hash, JSON.stringify({ email: normalized })],
    );
    await queueEmail({
      client, userId: input.userId, recipient: normalized, kind: "email_change", idempotencyKey: `email-change:${input.userId}:${token.hash}`,
      payload: { subject: "Confirm your Firecrawl Gateway email change", html: `<p>Confirm this email address by visiting <a href="${input.baseUrl}/admin/verify-email?token=${encodeURIComponent(token.token)}">this link</a>.</p>` }, encryptionKey: input.encryptionKey,
    });
  });
}

export async function consumeEmailVerification(token: string): Promise<boolean> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<{ user_id: string; purpose: string; metadata: { email?: string } }>(
      `SELECT user_id, purpose, metadata FROM auth_tokens WHERE purpose IN ('email_verification', 'email_change') AND token_hash = $1
       AND consumed_at IS NULL AND expires_at > NOW() FOR UPDATE`,
      [hashOpaqueToken(token)],
    );
    const row = result.rows[0];
    if (!row) return false;
    await client.query("UPDATE auth_tokens SET consumed_at = NOW() WHERE token_hash = $1", [hashOpaqueToken(token)]);
    if (row.purpose === "email_change" && row.metadata.email) {
      await client.query("UPDATE users SET email = $2, normalized_email = $2, email_verified_at = NOW(), auth_version = auth_version + 1, updated_at = NOW() WHERE id = $1", [row.user_id, row.metadata.email]);
      await client.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [row.user_id]);
    } else {
      await client.query("UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1", [row.user_id]);
    }
    await client.query("INSERT INTO security_events (id, user_id, event_type) VALUES ($1, $2, $3)", [crypto.randomUUID(), row.user_id, row.purpose === "email_change" ? "email_changed" : "email_verified"]);
    // Admission runs inside the verification transaction: a failure rolls the
    // token consumption back, so the verified user keeps a valid retry path
    // instead of being permanently stuck without an entitlement.
    if (row.purpose === "email_verification") {
      await admitAccountWithClient(client, `personal:${row.user_id}`);
    }
    return true;
  });
}

export async function requestPasswordReset(input: { email: string; encryptionKey: string; baseUrl: string }): Promise<void> {
  const normalized = input.email.trim().toLowerCase();
  await withOperatorTransaction(async (client) => {
    const result = await client.query<{ id: string; email: string }>(`${userSelect()} WHERE normalized_email = $1`, [normalized]);
    const user = result.rows[0];
    if (!user) return;
    const token = createOpaqueToken();
    await client.query("UPDATE auth_tokens SET consumed_at = NOW() WHERE user_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL", [user.id]);
    await client.query("INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'password_reset', $3, NOW() + INTERVAL '30 minutes')", [crypto.randomUUID(), user.id, token.hash]);
    await client.query("INSERT INTO security_events (id, user_id, event_type) VALUES ($1, $2, 'password_reset_requested')", [crypto.randomUUID(), user.id]);
    await queueEmail({
      client, userId: user.id, recipient: user.email, kind: "password_reset", idempotencyKey: `password-reset:${user.id}:${token.hash}`,
      payload: { subject: "Reset your Firecrawl Gateway password", html: `<p>Reset your password by visiting <a href="${input.baseUrl}/admin/reset-password?token=${encodeURIComponent(token.token)}">this link</a>.</p>` }, encryptionKey: input.encryptionKey,
    });
  });
}

export async function resetPassword(token: string, password: string, encryptionKey?: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return withOperatorTransaction(async (client) => {
    const result = await client.query<{ user_id: string; email: string }>(
      `SELECT t.user_id, u.email FROM auth_tokens t INNER JOIN users u ON u.id = t.user_id
       WHERE t.purpose = 'password_reset' AND t.token_hash = $1 AND t.consumed_at IS NULL AND t.expires_at > NOW() FOR UPDATE`,
      [hashOpaqueToken(token)],
    );
    const row = result.rows[0];
    if (!row) return false;
    await client.query("UPDATE auth_tokens SET consumed_at = NOW() WHERE token_hash = $1", [hashOpaqueToken(token)]);
    await client.query("UPDATE users SET password_hash = $2, auth_version = auth_version + 1, updated_at = NOW() WHERE id = $1", [row.user_id, passwordHash]);
    await client.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [row.user_id]);
    await client.query("INSERT INTO security_events (id, user_id, event_type) VALUES ($1, $2, 'password_reset_completed')", [crypto.randomUUID(), row.user_id]);
    if (encryptionKey) {
      await queueEmail({
        client, userId: row.user_id, recipient: row.email, kind: "password_changed", idempotencyKey: `password-changed:${row.user_id}:${Date.now()}`,
        payload: { subject: "Your Firecrawl Gateway password was changed", html: "<p>Your password was changed. If you did not make this change, contact an operator immediately.</p>" }, encryptionKey,
      });
    }
    return true;
  });
}
