import type { PoolClient } from "pg";
import { withAccountTransaction, withOperatorTransaction } from "./index";

export interface AccountRecord {
  id: string;
  public_id: string;
  display_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AccountMembershipRecord {
  account_id: string;
  user_id: string;
  role: "owner" | "member";
  created_at: string;
  updated_at: string;
}

export async function getAccountByPublicId(publicId: string): Promise<AccountRecord | null> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<AccountRecord>(
      `SELECT id, public_id, display_name, status, created_at, updated_at
       FROM accounts WHERE public_id = $1`,
      [publicId],
    );
    return result.rows[0] || null;
  });
}

export async function getPersonalAccountForUser(userId: string): Promise<AccountRecord | null> {
  return withOperatorTransaction(async (client) => {
    const result = await client.query<AccountRecord>(
      `SELECT a.id, a.public_id, a.display_name, a.status, a.created_at, a.updated_at
       FROM accounts a
       INNER JOIN account_memberships m ON m.account_id = a.id
       WHERE m.user_id = $1 AND m.role = 'owner'
       ORDER BY a.created_at ASC
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] || null;
  });
}

export async function listAccountMemberships(accountId: string): Promise<AccountMembershipRecord[]> {
  return withAccountTransaction(accountId, async (client) => {
    const result = await client.query<AccountMembershipRecord>(
      `SELECT account_id, user_id, role, created_at, updated_at
       FROM account_memberships
       WHERE account_id = $1
       ORDER BY created_at ASC, user_id ASC`,
      [accountId],
    );
    return result.rows;
  });
}

export async function withAccountRepository<T>(
  accountId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withAccountTransaction(accountId, fn);
}
