import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { AuditService } from "../audit/audit.service";
import type { StatsRange } from "../audit/audit-stats";
import { isValidTimeZone } from "../audit/audit-stats";
import { apiError } from "../common/http";
import type { RequestWithContext } from "../common/types";
import { UserGuard } from "../portal-auth/user.guard";
import { UsersService } from "../users/users.service";

const RANGES: readonly StatsRange[] = ["today", "week", "month", "all"];

/** The signed-in user's profile and the request usage of their own keys. */
@Controller("portal/api")
@UseGuards(UserGuard)
export class PortalAccountController {
  constructor(
    private readonly users: UsersService,
    private readonly keys: ApiKeysService,
    private readonly audit: AuditService,
  ) {}

  /** The user and the sign-in methods linked to them. */
  @Get("account")
  async account(@Req() request: RequestWithContext) {
    const user = request.user!;
    return { data: { user, identities: await this.users.listIdentities(user.id) } };
  }

  /**
   * Request counts per virtual key, from the audit log (which keeps 30 days), for the
   * user's active keys only. `range` defaults to the current month.
   */
  @Get("usage")
  async usage(@Req() request: RequestWithContext, @Query() query: { range?: string; tz?: string }) {
    const range = (query.range || "month") as StatsRange;
    if (!RANGES.includes(range)) apiError(400, "range is invalid");
    if (query.tz !== undefined && query.tz !== "" && !isValidTimeZone(query.tz))
      apiError(400, "tz is invalid");
    const keys = await this.keys.listUserApiKeys(request.user!.id);
    const rows = await this.audit.readApiKeyUsage({
      apiKeyIds: keys.map((key) => key.id),
      range,
      timeZone: query.tz || undefined,
    });
    const byKey = new Map(rows.map((row) => [row.api_key_id, row]));
    const perKey = keys.map((key) => {
      const row = byKey.get(key.id);
      return {
        api_key_id: key.id,
        name: key.name,
        key_prefix: key.key_prefix,
        total: row?.total ?? 0,
        error_count: row?.error_count ?? 0,
        avg_duration_ms: row?.avg_duration_ms ?? 0,
        last_request_at: row?.last_request_at ?? null,
      };
    });
    const total = perKey.reduce((sum, key) => sum + key.total, 0);
    const errors = perKey.reduce((sum, key) => sum + key.error_count, 0);
    const weightedMs = perKey.reduce((sum, key) => sum + key.avg_duration_ms * key.total, 0);
    return {
      data: {
        range,
        total,
        error_count: errors,
        avg_duration_ms: total ? Math.round(weightedMs / total) : 0,
        keys: perKey,
      },
    };
  }
}
