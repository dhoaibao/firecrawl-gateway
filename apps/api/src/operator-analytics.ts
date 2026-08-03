import { Prisma } from "@prisma/client";
import { withOperatorTransaction } from "./infrastructure/database";

const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

function boundedRange(from?: string, to?: string): { from: Date; to: Date } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error("from and to must be valid UTC timestamps with from before to");
  }
  if (end.getTime() - start.getTime() > MAX_RANGE_MS) throw new Error("Analytics range cannot exceed 31 days");
  return { from: start, to: end };
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

/** Database-side aggregates only; request logs are never loaded into Node. */
export async function getOperatorAnalytics(options: { from?: string; to?: string; limit?: number } = {}) {
  const range = boundedRange(options.from, options.to);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  return withOperatorTransaction(async (tx) => {
    const [series, dimensions, accounts, email, security] = await Promise.all([
      tx.$queryRaw<Array<{ bucket: Date; requests: bigint; errors: bigint; average_latency_ms: number }>>(Prisma.sql`
        SELECT date_trunc('hour', created_at) AS bucket, COUNT(*) AS requests,
          COUNT(*) FILTER (WHERE status_code >= 400) AS errors,
          COALESCE(AVG(duration_ms), 0) AS average_latency_ms
        FROM audit_logs WHERE created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY 1 ORDER BY 1 LIMIT 744
      `),
      tx.$queryRaw<Array<{ funding_type: string; backend_used: string; route_family: string; status_bucket: string; fallback: bigint; requests: bigint }>>(Prisma.sql`
        SELECT funding_type, backend_used,
          split_part(regexp_replace(path, '^/+', ''), '/', 1) AS route_family,
          CASE WHEN status_code < 300 THEN '2xx' WHEN status_code < 400 THEN '3xx'
               WHEN status_code < 500 THEN '4xx' ELSE '5xx' END AS status_bucket,
          COUNT(*) FILTER (WHERE fallback_used) AS fallback, COUNT(*) AS requests
        FROM audit_logs WHERE created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY funding_type, backend_used, route_family, status_bucket
        ORDER BY requests DESC LIMIT 400
      `),
      tx.$queryRaw<Array<{ user_id: string | null; account_id: string | null; requests: bigint; consumed: bigint }>>(Prisma.sql`
        SELECT user_id, account_id, COUNT(*) AS requests,
          COUNT(*) FILTER (WHERE funding_type = 'included') AS consumed
        FROM audit_logs WHERE created_at >= ${range.from} AND created_at < ${range.to}
          AND account_id IS NOT NULL
        GROUP BY user_id, account_id ORDER BY requests DESC LIMIT ${limit}
      `),
      tx.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`
        SELECT status, COUNT(*) AS count FROM email_outbox
        WHERE created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY status ORDER BY count DESC LIMIT 20
      `),
      tx.$queryRaw<Array<{ event_type: string; count: bigint }>>(Prisma.sql`
        SELECT event_type, COUNT(*) AS count FROM security_events
        WHERE created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY event_type ORDER BY count DESC LIMIT 50
      `),
    ]);
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      series: series.map((row) => ({ bucket: row.bucket.toISOString(), requests: number(row.requests), errors: number(row.errors), average_latency_ms: number(row.average_latency_ms) })),
      dimensions: dimensions.map((row) => ({ ...row, fallback: number(row.fallback), requests: number(row.requests) })),
      highest_usage_accounts: accounts.map((row) => ({ ...row, requests: number(row.requests), included_requests: number(row.consumed) })),
      email_delivery: email.map((row) => ({ status: row.status, count: number(row.count) })),
      security_events: security.map((row) => ({ event_type: row.event_type, count: number(row.count) })),
    };
  });
}
