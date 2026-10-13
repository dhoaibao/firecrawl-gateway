import { Body, Controller, Delete, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/guards";
import { apiError } from "../common/http";
import {
  PORTAL_DEFAULTS,
  UserAdminError,
  UsersAdminService,
  type UserPatch,
  type UserStateFilter,
} from "./users-admin.service";

const MAX_KEYS_CAP = 1_000;
const MAX_RATE_LIMIT_PER_MINUTE = 100_000;
const MAX_MONTHLY_QUOTA = 100_000_000;
const STATES: readonly UserStateFilter[] = ["active", "suspended", "deleted", "all"];

/** `undefined` leaves the field unchanged, `null` clears the override. */
function parseOverride(value: unknown, name: string, max: number): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
    apiError(400, `${name} must be an integer between 1 and ${max}, or null`);
  return value;
}

function fail(error: unknown): never {
  if (error instanceof UserAdminError) {
    if (error.reason === "not_found") return apiError(404, "User not found");
    return apiError(409, "This user was deleted");
  }
  throw error;
}

/** Administrator control of portal users (the single admin is not a user row). */
@Controller("admin/api/users")
@UseGuards(AuthGuard)
export class UsersAdminController {
  constructor(private readonly users: UsersAdminService) {}

  @Get()
  async list(@Query() query: { search?: string; state?: string; limit?: string; offset?: string }) {
    const state = (query.state || "active") as UserStateFilter;
    if (!STATES.includes(state)) apiError(400, "state is invalid");
    const search = query.search?.trim() || undefined;
    if (search && search.length > 200) apiError(400, "search is too long");
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) apiError(400, "limit is invalid");
    if (!Number.isInteger(offset) || offset < 0) apiError(400, "offset is invalid");
    const { total, users } = await this.users.list({ search, state, limit, offset });
    return { data: users, total, defaults: PORTAL_DEFAULTS };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    try {
      return { data: await this.users.get(id), defaults: PORTAL_DEFAULTS };
    } catch (error) {
      return fail(error);
    }
  }

  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body()
    body:
      | {
          status?: unknown;
          max_api_keys?: unknown;
          rate_limit_per_minute?: unknown;
          monthly_quota?: unknown;
        }
      | undefined,
  ) {
    if (body?.status !== undefined && body.status !== "active" && body.status !== "suspended")
      apiError(400, 'status must be "active" or "suspended"');
    const patch: UserPatch = {
      status: body?.status as UserPatch["status"],
      maxApiKeys: parseOverride(body?.max_api_keys, "max_api_keys", MAX_KEYS_CAP),
      rateLimitPerMinute: parseOverride(
        body?.rate_limit_per_minute,
        "rate_limit_per_minute",
        MAX_RATE_LIMIT_PER_MINUTE,
      ),
      monthlyQuota: parseOverride(body?.monthly_quota, "monthly_quota", MAX_MONTHLY_QUOTA),
    };
    if (Object.values(patch).every((value) => value === undefined))
      apiError(400, "status, max_api_keys, rate_limit_per_minute, or monthly_quota is required");
    try {
      return { data: await this.users.update(id, patch), defaults: PORTAL_DEFAULTS };
    } catch (error) {
      return fail(error);
    }
  }

  @Delete(":id")
  async remove(@Param("id") id: string) {
    try {
      await this.users.remove(id);
      return { success: true };
    } catch (error) {
      return fail(error);
    }
  }
}
