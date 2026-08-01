import crypto from "node:crypto";
import { withAccountTransaction, withClient, withUserAccountTransaction } from "../db";
import { encryptApiKey } from "./crypto";
import type { ApiKey, User } from "../types";

export interface AuthenticatedApiKey {
  key: ApiKey;
  user: User;
}

export interface CreatedApiKey {
  id: string;
  user_id: string;
  account_id?: string;
  name: string;
  key_prefix: string;
  revoked: boolean;
  created_at: string;
  updated_at: string;
  key: string; // plain key, retained for re-copying
}

export async function createApiKey(userId: string, name: string): Promise<CreatedApiKey> {
  const key = generateApiKey();
  const keyHash = hashApiKey(key);
  const keyPrefix = key.slice(0, 8);

  return withUserAccountTransaction(userId, async (accountId, client) => {
    const result = await client.query<ApiKey>(
      `INSERT INTO api_keys (id, user_id, account_id, name, key_hash, key_value, key_prefix, revoked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false)
       RETURNING *`,
      [crypto.randomUUID(), userId, accountId, name, keyHash, encryptApiKey(key), keyPrefix],
    );
    const row = result.rows[0];
    const { key_value: _keyValue, ...keyData } = row;
    return { ...keyData, key };
  });
}

export async function listApiKeys(userId?: string): Promise<ApiKey[]> {
  if (userId) {
    return withUserAccountTransaction(userId, async (accountId, client) => {
      const result = await client.query<ApiKey>(
        "SELECT * FROM api_keys WHERE account_id = $1 AND user_id = $2 ORDER BY created_at DESC",
        [accountId, userId],
      );
      return result.rows;
    });
  }

  return withClient(async (client) => {
    const result = await client.query<ApiKey>(
      "SELECT * FROM api_keys ORDER BY created_at DESC",
    );
    return result.rows;
  }, { operator: true });
}

export async function getApiKeyById(id: string, accountId?: string): Promise<ApiKey | null> {
  if (accountId) {
    return withAccountTransaction(accountId, async (client) => {
      const result = await client.query<ApiKey>(
        "SELECT * FROM api_keys WHERE id = $1 AND account_id = $2",
        [id, accountId],
      );
      return result.rows[0] || null;
    });
  }

  return withClient(async (client) => {
    const result = await client.query<ApiKey>(
      "SELECT * FROM api_keys WHERE id = $1",
      [id],
    );
    return result.rows[0] || null;
  }, { operator: true });
}

export async function revokeApiKey(id: string, accountId?: string): Promise<ApiKey | null> {
  const run = async (client: import("pg").PoolClient) => {
    const result = await client.query<ApiKey>(
      accountId
        ? "UPDATE api_keys SET revoked = true, updated_at = NOW() WHERE id = $1 AND account_id = $2 RETURNING *"
        : "UPDATE api_keys SET revoked = true, updated_at = NOW() WHERE id = $1 RETURNING *",
      accountId ? [id, accountId] : [id],
    );
    return result.rows[0] || null;
  };
  return accountId
    ? withAccountTransaction(accountId, run)
    : withClient(run, { operator: true });
}

export async function validateApiKey(key: string): Promise<ApiKey | null> {
  const keyHash = hashApiKey(key);
  return withClient(async (client) => {
    const result = await client.query<ApiKey>(
      "SELECT * FROM api_keys WHERE key_hash = $1 AND revoked = false",
      [keyHash],
    );
    return result.rows[0] || null;
  }, { operator: true });
}

export async function validateApiKeyWithUser(key: string): Promise<AuthenticatedApiKey | null> {
  const keyHash = hashApiKey(key);
  return withClient(async (client) => {
    const result = await client.query<ApiKey & {
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
       WHERE ak.key_hash = $1 AND ak.revoked = false AND u.email_verified_at IS NOT NULL`,
      [keyHash],
    );
    const row = result.rows[0];
    if (!row) return null;

    const {
      owner_id,
      owner_email,
      owner_name,
      owner_password_hash,
      owner_is_admin,
      owner_account_id,
      owner_status,
      owner_suspended_until,
      owner_created_at,
      owner_updated_at,
      owner_expired_suspension,
      ...apiKey
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
    }
    return { key: apiKey, user };
  }, { operator: true });
}

const TOUCH_DEBOUNCE_MS = 60_000;
const TOUCH_TRACKER_MAX_SIZE = 10_000;

// Map maintains insertion order, so we can use it as a simple LRU cache:
// deleting and re-inserting a key moves it to the end (most-recent), and the
// first entry is the least-recent when we need to evict.
const lastTouchById = new Map<string, number>();

export function clearTouchDebouncer(): void {
  lastTouchById.clear();
}

function recordTouch(id: string, timestamp: number): void {
  if (lastTouchById.has(id)) {
    lastTouchById.delete(id);
  } else if (lastTouchById.size >= TOUCH_TRACKER_MAX_SIZE) {
    const oldest = lastTouchById.keys().next().value;
    if (oldest !== undefined) {
      lastTouchById.delete(oldest);
    }
  }
  lastTouchById.set(id, timestamp);
}

export async function touchApiKey(id: string): Promise<void> {
  const now = Date.now();
  const lastTouch = lastTouchById.get(id);
  if (lastTouch && now - lastTouch < TOUCH_DEBOUNCE_MS) {
    // Refresh LRU position without touching the database.
    recordTouch(id, lastTouch);
    return;
  }

  await withClient(async (client) => {
    await client.query(
      "UPDATE api_keys SET last_used_at = NOW() WHERE id = $1",
      [id],
    );
  }, { operator: true });

  recordTouch(id, now);
}

function generateApiKey(): string {
  const prefix = "fc_";
  const randomPart = crypto.randomBytes(32).toString("base64url");
  return `${prefix}${randomPart}`;
}

function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
