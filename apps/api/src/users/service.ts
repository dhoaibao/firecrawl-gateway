import crypto from "node:crypto";
import { withClient, withOperatorTransaction, withTransaction } from "../db";
import type { User } from "../types";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const USER_SELECT = `
  SELECT u.*, personal_account.id AS account_id
  FROM users u
  LEFT JOIN LATERAL (
    SELECT a.id
    FROM accounts a
    INNER JOIN account_memberships m ON m.account_id = a.id
    WHERE m.user_id = u.id AND m.role = 'owner'
    ORDER BY a.created_at ASC
    LIMIT 1
  ) personal_account ON true`;

export async function createUser(
  email: string,
  name: string,
  passwordHash: string,
  isAdmin = false,
): Promise<User> {
  return withOperatorTransaction(async (client) => {
    const id = crypto.randomUUID();
    const normalizedEmail = normalizeEmail(email);
    const result = await client.query<User>(
      `INSERT INTO users (id, email, normalized_email, name, password_hash, is_admin, platform_role, status, suspended_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL)
       RETURNING *`,
      [id, email.trim(), normalizedEmail, name, passwordHash, isAdmin, isAdmin ? 'admin' : 'user'],
    );
    await client.query(
      `INSERT INTO accounts (id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [`personal:${id}`, name.trim() || normalizedEmail],
    );
    await client.query(
      `INSERT INTO account_memberships (account_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (account_id, user_id) DO NOTHING`,
      [`personal:${id}`, id],
    );
    return { ...result.rows[0], account_id: `personal:${id}` };
  });
}

async function maybeReactivate(
  client: import("pg").PoolClient,
  user: User | null,
): Promise<User | null> {
  if (!user) return null;
  if (user.status === "suspended" && user.suspended_until) {
    const until = new Date(user.suspended_until);
    if (until.getTime() <= Date.now()) {
      const result = await client.query<User>(
        "UPDATE users SET status = 'active', suspended_until = NULL WHERE id = $1 RETURNING *",
        [user.id],
      );
      return result.rows[0] || user;
    }
  }
  return user;
}

export async function getUserByEmail(email: string): Promise<User | null> {
  return withClient(async (client) => {
    const result = await client.query<User>(
      `${USER_SELECT}\n  WHERE u.normalized_email = $1`,
      [normalizeEmail(email)],
    );
    return maybeReactivate(client, result.rows[0] || null);
  }, { operator: true });
}

export async function getUserById(id: string): Promise<User | null> {
  return withClient(async (client) => {
    const result = await client.query<User>(
      `${USER_SELECT}\n  WHERE u.id = $1`,
      [id],
    );
    return maybeReactivate(client, result.rows[0] || null);
  }, { operator: true });
}

export async function listUsers(): Promise<User[]> {
  return withClient(async (client) => {
    const result = await client.query<User>(
      `${USER_SELECT}\n  ORDER BY u.created_at DESC`,
    );
    // Only reactivate in-place without DB writes to avoid side effects on reads
    return result.rows.map((u) => {
      if (u.status === "suspended" && u.suspended_until) {
        const until = new Date(u.suspended_until);
        if (until.getTime() <= Date.now()) {
          return { ...u, status: "active" as const, suspended_until: null };
        }
      }
      return u;
    });
  }, { operator: true });
}

export async function updateUser(
  id: string,
  updates: {
    name?: string;
    email?: string;
    password_hash?: string;
    is_admin?: boolean;
    status?: string;
    suspended_until?: string | null;
  },
): Promise<User | null> {
  return withClient(async (client) => {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      fields.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.email !== undefined) {
      fields.push(`email = $${paramIndex++}`);
      values.push(updates.email.trim());
      fields.push(`normalized_email = $${paramIndex++}`);
      values.push(normalizeEmail(updates.email));
    }
    if (updates.password_hash !== undefined) {
      fields.push(`password_hash = $${paramIndex++}`);
      values.push(updates.password_hash);
    }
    if (updates.is_admin !== undefined) {
      fields.push(`is_admin = $${paramIndex++}`);
      values.push(updates.is_admin);
      fields.push(`platform_role = $${paramIndex++}`);
      values.push(updates.is_admin ? "admin" : "user");
    }
    if (updates.status !== undefined) {
      fields.push(`status = $${paramIndex++}`);
      values.push(updates.status);
    }
    if (updates.suspended_until !== undefined) {
      fields.push(`suspended_until = $${paramIndex++}`);
      values.push(updates.suspended_until);
    }

    if (fields.length === 0) {
      return getUserById(id);
    }

    values.push(id);
    const result = await client.query<User>(
      `UPDATE users SET ${fields.join(", ")}, updated_at = NOW() WHERE id = $${paramIndex} RETURNING *`,
      values,
    );
    return result.rows[0] || null;
  });
}

export async function suspendUser(id: string, durationMs: number): Promise<User | null> {
  return withClient(async (client) => {
    const result = await client.query<User>(
      `UPDATE users SET status = 'suspended', suspended_until = NOW() + ($1 || ' milliseconds')::interval, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [String(durationMs), id],
    );
    return result.rows[0] || null;
  });
}

export async function blockUser(id: string): Promise<User | null> {
  return withClient(async (client) => {
    const result = await client.query<User>(
      `UPDATE users SET status = 'blocked', suspended_until = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id],
    );
    return result.rows[0] || null;
  });
}

export async function activateUser(id: string): Promise<User | null> {
  return withClient(async (client) => {
    const result = await client.query<User>(
      `UPDATE users SET status = 'active', suspended_until = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id],
    );
    return result.rows[0] || null;
  });
}

export function checkUserAccess(user: User): { allowed: true } | { allowed: false; reason: string } {
  if (user.status === "blocked") {
    return { allowed: false, reason: "Account blocked" };
  }
  if (user.status === "suspended") {
    if (user.suspended_until) {
      const until = new Date(user.suspended_until);
      const now = Date.now();
      if (until.getTime() > now) {
        const diff = until.getTime() - now;
        const hours = Math.ceil(diff / (1000 * 60 * 60));
        const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
        const label = days > 1 ? `${days} days` : `${hours} hour${hours > 1 ? "s" : ""}`;
        return { allowed: false, reason: `Account suspended. Try again in ${label}.` };
      }
    }
    // Auto-suspension (suspended_until = NULL) or any other suspended state blocks access.
    return { allowed: false, reason: "Account suspended" };
  }
  return { allowed: true };
}

export type DeleteUserResult = "deleted" | "not_found" | "last_admin";
const ADMIN_DELETE_GUARD_LOCK = 4_271_001;

export async function deleteUserSafely(id: string): Promise<DeleteUserResult> {
  return withTransaction(async (client) => {
    const targetResult = await client.query<Pick<User, "id" | "is_admin">>(
      "SELECT id, is_admin FROM users WHERE id = $1 FOR UPDATE",
      [id],
    );
    const target = targetResult.rows[0];
    if (!target) return "not_found";

    if (target.is_admin) {
      await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_DELETE_GUARD_LOCK]);
      const adminCount = await client.query<{ count: string }>(
        "SELECT COUNT(*) as count FROM users WHERE platform_role = 'admin' OR is_admin = true",
      );
      if (parseInt(adminCount.rows[0].count, 10) <= 1) return "last_admin";
    }

    await client.query("DELETE FROM users WHERE id = $1", [id]);
    return "deleted";
  });
}

export async function countUsers(): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM users",
    );
    return parseInt(result.rows[0].count, 10);
  });
}

export async function countAdmins(): Promise<number> {
  return withClient(async (client) => {
    const result = await client.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM users WHERE platform_role = 'admin' OR is_admin = true",
    );
    return parseInt(result.rows[0].count, 10);
  });
}
