import { Body, Controller, Delete, Get, Param, Query, UseGuards } from "@nestjs/common";
import { apiError } from "../common/http";
import { AuthGuard } from "../auth/guards";
import { AuditService, type AuditStatsFilter, type DeleteFilter } from "./audit.service";
import { isValidTimeZone, type StatsRange } from "./audit-stats";

const validFilters = ["today", "week", "month", "all"] as const;

function intParam(value: string | undefined, name: string, min: number, max: number) {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) apiError(400, `${name} is invalid`);
  return n;
}

function oneOf<T extends string>(value: string | undefined, name: string, allowed: readonly T[]) {
  if (value === undefined || value === "") return undefined;
  if (!allowed.includes(value as T)) apiError(400, `${name} is invalid`);
  return value as T;
}

export function parseStatsFilter(query: Record<string, string | undefined>): AuditStatsFilter {
  const search = query.search;
  if (search !== undefined && search.length > 200) apiError(400, "search is too long");
  const tz = query.tz === undefined || query.tz === "" ? undefined : query.tz;
  if (tz !== undefined && !isValidTimeZone(tz)) apiError(400, "tz is invalid");
  return {
    backend: oneOf(query.backend, "backend", ["self-hosted", "cloud"] as const),
    status: oneOf(query.status, "status", ["2xx", "4xx", "5xx"] as const),
    fallbackOnly: query.fallback === "true",
    slowOnly: query.slow === "true",
    search,
    range: oneOf<StatsRange>(query.range, "range", ["all", "today", "week", "month", "custom"]),
    day: intParam(query.day, "day", 1, 31),
    month: intParam(query.month, "month", 1, 12),
    year: intParam(query.year, "year", 1970, 9999),
    timeZone: tz,
  };
}

@Controller("admin/api")
@UseGuards(AuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get("logs")
  async logs() {
    return { data: await this.audit.readAuditEntries(500) };
  }

  @Delete("logs/:id")
  async deleteOne(@Param("id") id: string) {
    if (!(await this.audit.deleteAuditEntry(id))) apiError(404, "Audit entry not found");
    return { success: true };
  }

  @Delete("logs")
  async delete(@Query("filter") filter: string | undefined, @Body() body: { ids?: unknown }) {
    if (body?.ids !== undefined) {
      if (!Array.isArray(body.ids)) apiError(400, "ids must be an array");
      if (body.ids.some((id) => typeof id !== "string" || id.trim().length === 0))
        apiError(400, "ids must contain only non-empty strings");
      const ids = [...new Set((body.ids as string[]).map((id) => id.trim()))];
      if (ids.length === 0) apiError(400, "At least one log id is required");
      return { success: true, deleted: await this.audit.deleteAuditEntriesByIds(ids) };
    }
    if (!validFilters.includes(filter as (typeof validFilters)[number]))
      apiError(400, "Invalid filter. Use: today, week, month, or all");
    return { success: true, deleted: await this.audit.deleteAuditEntries(filter as DeleteFilter) };
  }

  @Get("stats")
  async stats(@Query() query: Record<string, string | undefined> = {}) {
    return { data: await this.audit.readAuditStats(parseStatsFilter(query)) };
  }

  @Get("data")
  async data(@Query("since") since: string | undefined) {
    let sinceDate: Date | undefined;
    if (since !== undefined && since !== "") {
      // Strict ISO-8601 UTC datetime, exactly the format the API emits via
      // toISOString() (the dashboard cursor depends on it). Loose forms such
      // as "2026-01-01" or "Jan 1 2026" are rejected.
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(since))
        apiError(400, "since must be a valid ISO timestamp");
      sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) apiError(400, "since must be a valid ISO timestamp");
    }
    const entries = await this.audit.readAuditEntries(500, sinceDate);
    return { data: entries };
  }
}
