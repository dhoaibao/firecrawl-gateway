import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { AuditEntry } from "../common/types";
import { buildStatsWhere, statsQuery, type AuditStats, type AuditStatsFilter } from "./audit-stats";

export type { AuditStats, AuditStatsFilter };

export type DeleteFilter = "today" | "week" | "month" | "all";

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
  };
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async appendAudit(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          id: entry.id,
          createdAt: new Date(entry.created_at),
          method: entry.method,
          path: entry.path,
          routeMode: entry.route_mode,
          backendUsed: entry.backend_used,
          fallbackUsed: entry.fallback_used,
          fallbackReason: entry.fallback_reason,
          statusCode: entry.status_code,
          durationMs: entry.duration_ms,
          targetUrl: entry.target_url,
          requestId: entry.request_id ?? null,
        },
      });
    } catch (error) {
      // An audit failure must not make an upstream request fail.
      console.warn("Failed to write audit entry", { id: entry.id, error });
    }
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
