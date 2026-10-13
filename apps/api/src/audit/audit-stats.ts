import { Prisma } from "@prisma/client";

export interface AuditStats {
  total: number;
  self_hosted: number;
  cloud: number;
  fallbacks: number;
  success_count: number;
  error_count: number;
  avg_duration_ms: number;
}

/** Request counts for one virtual API key; `api_key_id` is null for unattributed rows. */
export interface ApiKeyUsage {
  api_key_id: string | null;
  total: number;
  error_count: number;
  fallbacks: number;
  avg_duration_ms: number;
  last_request_at: string | null;
}

/** Raw row shape returned by `apiKeyUsageQuery`. */
export interface ApiKeyUsageRow {
  api_key_id: string | null;
  total: number | bigint;
  error_count: number | bigint;
  fallbacks: number | bigint;
  avg_duration_ms: number | bigint | null;
  last_request_at: Date | string | null;
}

export type StatsRange = "all" | "today" | "week" | "month" | "custom";

/** Mirrors the dashboard filters so cards can be aggregated over the whole log. */
export interface AuditStatsFilter {
  backend?: "self-hosted" | "cloud";
  status?: "2xx" | "4xx" | "5xx";
  fallbackOnly?: boolean;
  slowOnly?: boolean;
  search?: string;
  /** Restrict to one virtual API key (`audit_logs.api_key_id`). */
  apiKeyId?: string;
  /** Restrict to any of these keys; an empty list matches nothing. */
  apiKeyIds?: string[];
  range?: StatsRange;
  day?: number;
  month?: number;
  year?: number;
  /** Client IANA time zone (e.g. "Asia/Ho_Chi_Minh"); calendar boundaries honour DST. */
  timeZone?: string;
}

export function isValidTimeZone(value: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function buildStatsWhere(filter: AuditStatsFilter): Prisma.Sql {
  const tz = filter.timeZone ?? "UTC";
  const conds: Prisma.Sql[] = [];

  if (filter.backend) conds.push(Prisma.sql`backend_used = ${filter.backend}`);
  if (filter.status === "2xx") conds.push(Prisma.sql`status_code >= 200 AND status_code < 300`);
  if (filter.status === "4xx") conds.push(Prisma.sql`status_code >= 400 AND status_code < 500`);
  if (filter.status === "5xx") conds.push(Prisma.sql`status_code >= 500 AND status_code < 600`);
  if (filter.fallbackOnly) conds.push(Prisma.sql`fallback_used = true`);
  if (filter.slowOnly) conds.push(Prisma.sql`duration_ms >= 1000`);
  if (filter.apiKeyId) conds.push(Prisma.sql`api_key_id = ${filter.apiKeyId}`);
  if (filter.apiKeyIds)
    conds.push(
      filter.apiKeyIds.length
        ? Prisma.sql`api_key_id IN (${Prisma.join(filter.apiKeyIds)})`
        : Prisma.sql`FALSE`,
    );

  const search = filter.search?.trim().toLowerCase();
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    conds.push(
      Prisma.sql`lower(concat_ws(' ', path, target_url, method, backend_used, route_mode, fallback_reason)) LIKE ${pattern} ESCAPE '\\'`,
    );
  }

  const range = filter.range ?? "all";
  // created_at is TIMESTAMPTZ: AT TIME ZONE yields a zone-independent local
  // timestamp, so extract() and date_trunc() follow the client's calendar
  // (including DST) rather than the database session zone.
  const nowLocal = Prisma.sql`(now() AT TIME ZONE ${tz}::text)`;
  const bound = (local: Prisma.Sql) => Prisma.sql`((${local}) AT TIME ZONE ${tz}::text)`;
  if (range === "custom") {
    // Day / month / year are matched independently in the client's local time.
    const localTs = Prisma.sql`(created_at AT TIME ZONE ${tz}::text)`;
    if (filter.day !== undefined)
      conds.push(Prisma.sql`extract(day from ${localTs}) = ${filter.day}`);
    if (filter.month !== undefined)
      conds.push(Prisma.sql`extract(month from ${localTs}) = ${filter.month}`);
    if (filter.year !== undefined)
      conds.push(Prisma.sql`extract(year from ${localTs}) = ${filter.year}`);
  } else if (range === "today") {
    const start = Prisma.sql`date_trunc('day', ${nowLocal})`;
    conds.push(Prisma.sql`created_at >= ${bound(start)}`);
    conds.push(Prisma.sql`created_at < ${bound(Prisma.sql`${start} + interval '1 day'`)}`);
  } else if (range === "week") {
    // Dashboard: now - 168h (absolute), then floor to local midnight; `hours`
    // keeps the subtraction absolute instead of calendar-day (DST-shifted).
    const start = Prisma.sql`date_trunc('day', ((now() - interval '168 hours') AT TIME ZONE ${tz}::text))`;
    conds.push(Prisma.sql`created_at >= ${bound(start)}`);
  } else if (range === "month") {
    const start = Prisma.sql`date_trunc('month', ${nowLocal})`;
    conds.push(Prisma.sql`created_at >= ${bound(start)}`);
    conds.push(Prisma.sql`created_at < ${bound(Prisma.sql`${start} + interval '1 month'`)}`);
  }

  return conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}` : Prisma.empty;
}

export function statsQuery(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      count(*)::int AS total,
      (count(*) FILTER (WHERE backend_used = 'self-hosted'))::int AS self_hosted,
      (count(*) FILTER (WHERE backend_used = 'cloud'))::int AS cloud,
      (count(*) FILTER (WHERE fallback_used))::int AS fallbacks,
      (count(*) FILTER (WHERE status_code >= 200 AND status_code < 300))::int AS success_count,
      (count(*) FILTER (WHERE status_code >= 400))::int AS error_count,
      coalesce(round(avg(duration_ms)), 0)::int AS avg_duration_ms
    FROM audit_logs
    ${where}`;
}

export function apiKeyUsageQuery(where: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT
      api_key_id,
      count(*)::int AS total,
      (count(*) FILTER (WHERE status_code >= 400))::int AS error_count,
      (count(*) FILTER (WHERE fallback_used))::int AS fallbacks,
      coalesce(round(avg(duration_ms)), 0)::int AS avg_duration_ms,
      max(created_at) AS last_request_at
    FROM audit_logs
    ${where}
    GROUP BY api_key_id
    ORDER BY total DESC`;
}
