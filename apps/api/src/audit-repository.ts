import type { AuditEntry } from "./types";
import { withAccountTransaction } from "./db";

/** Tenant-scoped audit reads always carry both transaction context and SQL predicates. */
export async function readAuditEntriesForAccount(
  accountId: string,
  limit = 250,
): Promise<AuditEntry[]> {
  return withAccountTransaction(accountId, async (client) => {
    const result = await client.query<AuditEntry>(
      `SELECT id, created_at, method, path, route_mode, backend_used, fallback_used,
              fallback_reason, status_code, duration_ms, target_url, user_id, account_id, request_id
       FROM audit_logs
       WHERE account_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [accountId, limit],
    );
    return result.rows;
  });
}
