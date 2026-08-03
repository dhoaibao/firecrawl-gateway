import { withAccountTransaction, withOperatorTransaction } from "./infrastructure/database";
import type { AuditEntry } from "./types";

export type AuditDeletionException = "legal" | "account-deletion";

function requireDeletionException(exception?: AuditDeletionException): void {
  if (!exception) throw new Error("Audit deletion requires an approved legal or account-deletion exception");
}

function toDate(value: string): Date {
  return new Date(value);
}

function mapEntry(row: {
  id: string;
  createdAt: Date;
  method: string;
  path: string;
  routeMode: string;
  backendUsed: string;
  fundingType: string;
  fallbackUsed: boolean;
  fallbackReason: string;
  statusCode: number;
  durationMs: number;
  targetUrl: string;
  userId: string | null;
  accountId: string | null;
  requestId: string | null;
}): AuditEntry {
  return {
    id: row.id,
    created_at: row.createdAt.toISOString(),
    method: row.method,
    path: row.path,
    route_mode: row.routeMode,
    backend_used: row.backendUsed,
    funding_type: row.fundingType as AuditEntry["funding_type"],
    fallback_used: row.fallbackUsed,
    fallback_reason: row.fallbackReason,
    status_code: row.statusCode,
    duration_ms: row.durationMs,
    target_url: row.targetUrl,
    user_id: row.userId ?? undefined,
    account_id: row.accountId ?? undefined,
    request_id: row.requestId ?? undefined,
  };
}

const auditSelect = {
  id: true,
  createdAt: true,
  method: true,
  path: true,
  routeMode: true,
  backendUsed: true,
  fundingType: true,
  fallbackUsed: true,
  fallbackReason: true,
  statusCode: true,
  durationMs: true,
  targetUrl: true,
  userId: true,
  accountId: true,
  requestId: true,
} as const;

function createData(entry: AuditEntry) {
  return {
    id: entry.id,
    createdAt: toDate(entry.created_at),
    method: entry.method,
    path: entry.path,
    routeMode: entry.route_mode,
    backendUsed: entry.backend_used,
    fundingType: entry.funding_type ?? "unknown",
    fallbackUsed: entry.fallback_used,
    fallbackReason: entry.fallback_reason,
    statusCode: entry.status_code,
    durationMs: entry.duration_ms,
    targetUrl: entry.target_url,
    userId: entry.user_id ?? null,
    accountId: entry.account_id ?? null,
    requestId: entry.request_id ?? null,
  };
}

export async function appendAuditEntries(entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await withOperatorTransaction(async (tx) => {
    await tx.auditLog.createMany({ data: entries.map(createData), skipDuplicates: true });
  });
}

export async function readAuditEntries(limit = 250): Promise<AuditEntry[]> {
  return withOperatorTransaction(async (tx) => {
    const rows = await tx.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: limit, select: auditSelect });
    return rows.map(mapEntry);
  });
}

export async function readAuditEntriesForAccount(accountId: string, limit = 250): Promise<AuditEntry[]> {
  return withAccountTransaction(accountId, async (tx) => {
    const rows = await tx.auditLog.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: auditSelect,
    });
    return rows.map(mapEntry);
  });
}

export async function deleteAuditEntriesByIds(ids: string[], exception?: AuditDeletionException): Promise<string[]> {
  requireDeletionException(exception);
  if (ids.length === 0) return [];
  return withOperatorTransaction(async (tx) => {
    const rows = await tx.auditLog.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (rows.length > 0) {
      await tx.auditLog.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    }
    return rows.map((row) => row.id);
  });
}

export async function deleteAuditEntry(id: string, exception?: AuditDeletionException): Promise<boolean> {
  requireDeletionException(exception);
  const result = await withOperatorTransaction((tx) => tx.auditLog.deleteMany({ where: { id } }));
  return result.count > 0;
}

export async function deleteAuditEntries(filter: "today" | "week" | "month" | "all", exception?: AuditDeletionException): Promise<string[]> {
  requireDeletionException(exception);
  if (filter === "all") {
    throw new Error("Unbounded audit deletion is disabled; use the retention worker or an approved exception");
  }
  const where = (() => {
    const now = new Date();
    if (filter === "week") return { createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } };
    if (filter === "today") {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      return { createdAt: { gte: start, lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) } };
    }
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { createdAt: { gte: start, lt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) } };
  })();
  return withOperatorTransaction(async (tx) => {
    const rows = await tx.auditLog.findMany({ where, select: { id: true } });
    if (rows.length > 0) {
      await tx.auditLog.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    }
    return rows.map((row) => row.id);
  });
}

/** Delete one bounded retention batch; quota ledger and reconciliation tables are never queried. */
export async function deleteAuditEntriesBefore(cutoff: Date, batchSize = 1_000): Promise<number> {
  const limit = Math.max(1, Math.min(batchSize, 1_000));
  return withOperatorTransaction(async (tx) => {
    const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended('firecrawl-audit-retention', 0)) AS locked`;
    if (!lock[0]?.locked) return 0;
    const rows = await tx.auditLog.findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true },
    });
    if (rows.length === 0) return 0;
    const result = await tx.auditLog.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    return result.count;
  });
}
