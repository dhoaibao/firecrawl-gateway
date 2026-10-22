import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuditEntry } from "../common/types";
import {
  apiKeyUsageQuery,
  buildStatsWhere,
  statsQuery,
  type ApiKeyUsage,
  type ApiKeyUsageRow,
  type AuditStats,
  type AuditStatsFilter,
} from "./audit-stats";

export type { ApiKeyUsage, AuditStats, AuditStatsFilter };

export type DeleteFilter = "today" | "week" | "month" | "all";

// Entries are buffered and inserted in batches, so a proxied request never waits on its
// own INSERT. A crash (not a graceful shutdown) loses at most one interval of entries.
const FLUSH_INTERVAL_MS = 1_000;
const MAX_BATCH = 200;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
// Bound memory while PostgreSQL is slow or down, counting queued and in-flight entries;
// entries beyond either cap are dropped. Bytes matter because a target URL comes from the
// request body and can be megabytes long.
const MAX_PENDING = 10_000;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
// Rough cost of a row's fixed fields, so many tiny rows are not counted as free.
const ROW_OVERHEAD_BYTES = 256;

function toEntry(entry: {
  id: string;
  createdAt: Date;
  method: string;
  path: string;
  routeMode: string;
  backendUsed: string;
  fallbackUsed: boolean;
  fallbackReason: string;
  statusCode: number;
  durationMs: number;
  targetUrl: string;
  requestId: string | null;
  apiKeyId: string | null;
}): AuditEntry {
  return {
    id: entry.id,
    created_at: entry.createdAt.toISOString(),
    method: entry.method,
    path: entry.path,
    route_mode: entry.routeMode,
    backend_used: entry.backendUsed,
    fallback_used: entry.fallbackUsed,
    fallback_reason: entry.fallbackReason,
    status_code: entry.statusCode,
    duration_ms: entry.durationMs,
    target_url: entry.targetUrl,
    request_id: entry.requestId ?? undefined,
    api_key_id: entry.apiKeyId ?? undefined,
  };
}

// PostgreSQL text rejects NUL, and fields like the target URL come from the request body.
function pgText(value: string): string {
  return value.replaceAll("\0", "");
}

/** Approximate in-memory size of a queued row (UTF-16 code units of its variable fields). */
function rowBytes(row: Prisma.AuditLogCreateManyInput): number {
  return (
    ROW_OVERHEAD_BYTES +
    row.path.length +
    (row.targetUrl?.length ?? 0) +
    (row.fallbackReason?.length ?? 0) +
    (row.requestId?.length ?? 0)
  );
}

function toRow(entry: AuditEntry): Prisma.AuditLogCreateManyInput {
  return {
    id: entry.id,
    createdAt: new Date(entry.created_at),
    method: pgText(entry.method),
    path: pgText(entry.path),
    routeMode: pgText(entry.route_mode),
    backendUsed: pgText(entry.backend_used),
    fallbackUsed: entry.fallback_used,
    fallbackReason: pgText(entry.fallback_reason),
    statusCode: entry.status_code,
    durationMs: entry.duration_ms,
    targetUrl: pgText(entry.target_url),
    requestId: entry.request_id == null ? null : pgText(entry.request_id),
    apiKeyId: entry.api_key_id ?? null,
  };
}

@Injectable()
export class AuditService implements OnModuleDestroy {
  private pending: Prisma.AuditLogCreateManyInput[] = [];
  /** Size of the queued plus in-flight rows; released when their write settles. */
  private bufferedBytes = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;

  constructor(private readonly prisma: PrismaService) {}

  /** Queues an entry for the next batch insert; it never waits on PostgreSQL. */
  async appendAudit(entry: AuditEntry): Promise<void> {
    const row = toRow(entry);
    const bytes = rowBytes(row);
    if (this.pending.length >= MAX_PENDING || this.bufferedBytes + bytes > MAX_PENDING_BYTES) {
      console.warn("Dropped audit entry: write queue is full", { id: entry.id });
      return;
    }
    this.bufferedBytes += bytes;
    this.pending.push(row);
    if (this.pending.length >= MAX_BATCH) void this.flush();
    else this.scheduleFlush();
  }

  /** Writes queued entries while the database is still connected. */
  async onModuleDestroy(): Promise<void> {
    // Entries queued while a batch was in flight are written by the next pass.
    while (this.flushing || this.pending.length) await this.flush();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      // Forget the fired handle first: flush() returns early while a batch is in flight,
      // and a stale handle would block every later schedule.
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    // A pending flush must never keep the process alive; onModuleDestroy covers shutdown.
    this.flushTimer.unref?.();
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushing = this.writePending().finally(() => {
      this.flushing = undefined;
      if (this.pending.length) this.scheduleFlush();
    });
    return this.flushing;
  }

  private async writePending(): Promise<void> {
    while (this.pending.length) {
      const batch = this.takeBatch();
      try {
        await this.prisma.auditLog.createMany({ data: batch });
      } catch {
        // One rejected row must not take the rest of its batch down, so retry them one by
        // one; an audit failure still never makes an upstream request fail.
        await Promise.all(
          batch.map((row) =>
            this.prisma.auditLog.create({ data: row }).catch((error: unknown) => {
              console.warn("Failed to write audit entry", { id: row.id, error });
            }),
          ),
        );
      } finally {
        for (const row of batch) this.bufferedBytes -= rowBytes(row);
      }
    }
  }

  /** Takes up to MAX_BATCH rows and MAX_BATCH_BYTES (always at least one row). */
  private takeBatch(): Prisma.AuditLogCreateManyInput[] {
    let count = 0;
    let bytes = 0;
    while (count < this.pending.length && count < MAX_BATCH) {
      bytes += rowBytes(this.pending[count]);
      if (count > 0 && bytes > MAX_BATCH_BYTES) break;
      count += 1;
    }
    return this.pending.splice(0, count);
  }

  async readAuditEntries(limit = 500, since?: Date): Promise<AuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      ...(since ? { where: { createdAt: { gte: since } } } : {}),
    });
    return rows.map(toEntry);
  }

  /** Aggregates over the whole audit log (not capped like readAuditEntries). */
  async readAuditStats(filter: AuditStatsFilter = {}): Promise<AuditStats> {
    const rows = await this.prisma.$queryRaw<AuditStats[]>(statsQuery(buildStatsWhere(filter)));
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      self_hosted: Number(row?.self_hosted ?? 0),
      cloud: Number(row?.cloud ?? 0),
      fallbacks: Number(row?.fallbacks ?? 0),
      success_count: Number(row?.success_count ?? 0),
      error_count: Number(row?.error_count ?? 0),
      avg_duration_ms: Number(row?.avg_duration_ms ?? 0),
    };
  }

  /**
   * Per-key request counts over the (filtered) audit log. Rows without a key
   * (playground, rejected requests, entries from before attribution) are grouped
   * under `api_key_id: null`. Counts come from the audit log, so they shrink when
   * entries are deleted or purged by the 30-day maintenance job.
   */
  async readApiKeyUsage(filter: AuditStatsFilter = {}): Promise<ApiKeyUsage[]> {
    const rows = await this.prisma.$queryRaw<ApiKeyUsageRow[]>(
      apiKeyUsageQuery(buildStatsWhere(filter)),
    );
    return rows.map((row) => ({
      api_key_id: row.api_key_id ?? null,
      total: Number(row.total ?? 0),
      error_count: Number(row.error_count ?? 0),
      fallbacks: Number(row.fallbacks ?? 0),
      avg_duration_ms: Number(row.avg_duration_ms ?? 0),
      last_request_at: row.last_request_at ? new Date(row.last_request_at).toISOString() : null,
    }));
  }

  async deleteAuditEntry(id: string): Promise<boolean> {
    try {
      await this.prisma.auditLog.delete({ where: { id } });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025")
        return false;
      throw error;
    }
  }

  async deleteAuditEntriesByIds(ids: string[]): Promise<number> {
    return (
      await this.prisma.auditLog.deleteMany({
        where: { id: { in: [...new Set(ids.filter(Boolean))] } },
      })
    ).count;
  }

  async deleteAuditEntries(filter: DeleteFilter): Promise<number> {
    if (filter === "all") return (await this.prisma.auditLog.deleteMany()).count;
    const now = new Date();
    const from =
      filter === "today"
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        : filter === "month"
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
          : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const to =
      filter === "today"
        ? new Date(from.getTime() + 24 * 60 * 60 * 1000)
        : filter === "month"
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
          : undefined;
    return (
      await this.prisma.auditLog.deleteMany({
        where: { createdAt: { gte: from, ...(to ? { lt: to } : {}) } },
      })
    ).count;
  }
}
