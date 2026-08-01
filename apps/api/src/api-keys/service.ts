import crypto from "node:crypto";
import { withAccountTransaction, withClient, withUserAccountTransaction } from "../db";
import { resumeAccountEntitlementsWithClient } from "../quota/service";
import type { GatewayToken, User } from "../types";

/** Compatibility name for the legacy module; product-facing callers should say gateway token. */
export interface AuthenticatedApiKey {
  key: GatewayToken;
  user: User;
}

export interface CreatedApiKey {
  id: string;
  user_id: string;
  account_id?: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  expires_at: string | null;
  inactivity_timeout_seconds: number | null;
  revoked: boolean;
  created_at: string;
  updated_at: string;
  /** Returned exactly once by the create operation; never persisted in decryptable form. */
  key: string;
}

export interface CreateGatewayTokenOptions {
  scopes?: string[];
  expiresAt?: string | null;
  inactivityTimeoutSeconds?: number | null;
}

export async function createApiKey(
  userId: string,
  name: string,
  options: CreateGatewayTokenOptions = {},
): Promise<CreatedApiKey> {
  const key = generateApiKey();
  const keyHash = hashApiKey(key);
  const keyPrefix = key.slice(0, 8);
  const scopes = normalizeScopes(options.scopes);
  const expiresAt = options.expiresAt ?? null;
  const inactivityTimeoutSeconds = options.inactivityTimeoutSeconds ?? null;

  return withUserAccountTransaction(userId, async (accountId, client) => {
    const result = await client.query<GatewayToken>(
      `INSERT INTO api_keys (
        id, user_id, account_id, name, key_hash, key_value, key_prefix, scopes,
        expires_at, inactivity_timeout_seconds, revoked
      ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, false)
      RETURNING *`,
      [crypto.randomUUID(), userId, accountId, name, keyHash, keyPrefix, scopes, expiresAt, inactivityTimeoutSeconds],
    );
    const row = result.rows[0];
    const { key_hash: _keyHash, key_value: _keyValue, ...keyData } = row;
    return {
      ...keyData,
      scopes: row.scopes ?? ["*"],
      expires_at: row.expires_at ?? null,
      inactivity_timeout_seconds: row.inactivity_timeout_seconds ?? null,
      key,
    };
  });
}

export async function listApiKeys(userId?: string): Promise<GatewayToken[]> {
  if (userId) {
    return withUserAccountTransaction(userId, async (accountId, client) => {
      const result = await client.query<GatewayToken>(
        "SELECT * FROM api_keys WHERE account_id = $1 AND user_id = $2 ORDER BY created_at DESC",
        [accountId, userId],
      );
      return result.rows;
    });
  }

  return withClient(async (client) => {
    const result = await client.query<GatewayToken>("SELECT * FROM api_keys ORDER BY created_at DESC");
    return result.rows;
  }, { operator: true });
}

export async function getApiKeyById(id: string, accountId?: string): Promise<GatewayToken | null> {
  if (accountId) {
    return withAccountTransaction(accountId, async (client) => {
      const result = await client.query<GatewayToken>(
        "SELECT * FROM api_keys WHERE id = $1 AND account_id = $2",
        [id, accountId],
      );
      return result.rows[0] || null;
    });
  }
  return withClient(async (client) => {
    const result = await client.query<GatewayToken>("SELECT * FROM api_keys WHERE id = $1", [id]);
    return result.rows[0] || null;
  }, { operator: true });
}

export async function revokeApiKey(id: string, accountId?: string): Promise<GatewayToken | null> {
  const run = async (client: import("pg").PoolClient) => {
    const result = await client.query<GatewayToken>(
      accountId
        ? "UPDATE api_keys SET revoked = true, updated_at = NOW() WHERE id = $1 AND account_id = $2 RETURNING *"
        : "UPDATE api_keys SET revoked = true, updated_at = NOW() WHERE id = $1 RETURNING *",
      accountId ? [id, accountId] : [id],
    );
    return result.rows[0] || null;
  };
  return accountId ? withAccountTransaction(accountId, run) : withClient(run, { operator: true });
}

export async function validateApiKey(key: string): Promise<GatewayToken | null> {
  const keyHash = hashApiKey(key);
  return withClient(async (client) => {
    const result = await client.query<GatewayToken>(
      `SELECT * FROM api_keys
       WHERE key_hash = $1 AND revoked = false
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (inactivity_timeout_seconds IS NULL OR
              COALESCE(last_used_at, created_at) + make_interval(secs => inactivity_timeout_seconds) > NOW())`,
      [keyHash],
    );
    return result.rows[0] || null;
  }, { operator: true });
}

export async function validateApiKeyWithUser(key: string): Promise<AuthenticatedApiKey | null> {
  const keyHash = hashApiKey(key);
  const authenticated = await withClient(async (client) => {
    const result = await client.query<GatewayToken & {
      owner_id: string;
      owner_email: string;
      owner_name: string;
      owner_password_hash: string;
      owner_is_admin: boolean;
      owner_account_id: string;
      owner_status: string;
      owner_suspended_until: string | null;
      owner_created_at: string;
      owner_updated_at: string;
      owner_expired_suspension: boolean;
    }>(
      `SELECT ak.*, u.id AS owner_id, u.email AS owner_email, u.name AS owner_name,
              u.password_hash AS owner_password_hash, u.is_admin AS owner_is_admin,
              ak.account_id AS owner_account_id,
              CASE WHEN u.status = 'suspended' AND u.suspended_until <= NOW()
                   THEN 'active' ELSE u.status END AS owner_status,
              CASE WHEN u.status = 'suspended' AND u.suspended_until <= NOW()
                   THEN NULL ELSE u.suspended_until END AS owner_suspended_until,
              u.created_at AS owner_created_at, u.updated_at AS owner_updated_at,
              (u.status = 'suspended' AND u.suspended_until <= NOW()) AS owner_expired_suspension
       FROM api_keys ak
       INNER JOIN users u ON u.id = ak.user_id
       WHERE ak.key_hash = $1 AND ak.revoked = false AND u.email_verified_at IS NOT NULL
         AND (ak.expires_at IS NULL OR ak.expires_at > NOW())
         AND (ak.inactivity_timeout_seconds IS NULL OR
              COALESCE(ak.last_used_at, ak.created_at) + make_interval(secs => ak.inactivity_timeout_seconds) > NOW())`,
      [keyHash],
    );
    const row = result.rows[0];
    if (!row) return null;

    const {
      owner_id, owner_email, owner_name, owner_password_hash, owner_is_admin,
      owner_account_id, owner_status, owner_suspended_until, owner_created_at,
      owner_updated_at, owner_expired_suspension, ...gatewayToken
    } = row;
    let user: User = {
      id: owner_id,
      email: owner_email,
      name: owner_name,
      password_hash: owner_password_hash,
      is_admin: owner_is_admin,
      account_id: owner_account_id,
      status: owner_status,
      suspended_until: owner_suspended_until,
      created_at: owner_created_at,
      updated_at: owner_updated_at,
    };
    if (owner_expired_suspension) {
      const reactivated = await client.query<User>(
        "UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1 RETURNING *",
        [owner_id],
      );
      user = reactivated.rows[0] || user;
      if (owner_account_id) {
        // Keep user and entitlement reactivation in the same transaction. If
        // quota resume fails, the user update rolls back and a later key
        // validation can retry the complete reactivation.
        await resumeAccountEntitlementsWithClient(client, owner_account_id);
      }
    }
    return { key: gatewayToken, user };
  }, { operator: true });

  return authenticated;
}

const TOUCH_DEBOUNCE_MS = 60_000;
const TOUCH_TRACKER_MAX_SIZE = 10_000;
const lastTouchById = new Map<string, number>();

export function clearTouchDebouncer(): void {
  lastTouchById.clear();
}

function recordTouch(id: string, timestamp: number): void {
  if (lastTouchById.has(id)) lastTouchById.delete(id);
  else if (lastTouchById.size >= TOUCH_TRACKER_MAX_SIZE) {
    const oldest = lastTouchById.keys().next().value;
    if (oldest !== undefined) lastTouchById.delete(oldest);
  }
  lastTouchById.set(id, timestamp);
}

export async function touchApiKey(id: string): Promise<void> {
  const now = Date.now();
  const lastTouch = lastTouchById.get(id);
  if (lastTouch && now - lastTouch < TOUCH_DEBOUNCE_MS) {
    recordTouch(id, lastTouch);
    return;
  }
  await withClient(async (client) => {
    await client.query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [id]);
  }, { operator: true });
  recordTouch(id, now);
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) return ["*"];
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (normalized.length === 0 || normalized.some((scope) => scope.length > 128)) {
    throw new Error("Gateway token scopes must be non-empty strings up to 128 characters");
  }
  return normalized;
}

function generateApiKey(): string {
  return `fc_${crypto.randomBytes(32).toString("base64url")}`;
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
