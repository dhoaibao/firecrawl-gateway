import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { apiError } from "../common/http";
import { AuthGuard } from "../auth/guards";
import { ApiKeysService, type ApiKeyRecord } from "./api-keys.service";

const MAX_RATE_LIMIT_PER_MINUTE = 100_000;
const MAX_MONTHLY_QUOTA = 100_000_000;

function sanitizeKey(key: ApiKeyRecord & { key?: unknown }) {
  const { key: _key, key_hash: _keyHash, key_value: _keyValue, ...rest } = key;
  return rest;
}

/** `undefined` leaves the field unchanged, `null` clears it, a string must be a future ISO time. */
function parseExpiresAt(value: unknown): Date | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") apiError(400, "expires_at must be an ISO timestamp or null");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) apiError(400, "expires_at must be a valid ISO timestamp");
  if (date.getTime() <= Date.now()) apiError(400, "expires_at must be in the future");
  return date;
}

function parseRateLimit(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_RATE_LIMIT_PER_MINUTE
  )
    apiError(
      400,
      `rate_limit_per_minute must be an integer between 1 and ${MAX_RATE_LIMIT_PER_MINUTE}, or null`,
    );
  return value;
}

function parseMonthlyQuota(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_MONTHLY_QUOTA
  )
    apiError(400, `monthly_quota must be an integer between 1 and ${MAX_MONTHLY_QUOTA}, or null`);
  return value;
}

interface LimitsBody {
  expires_at?: unknown;
  rate_limit_per_minute?: unknown;
  monthly_quota?: unknown;
}

function parseLimits(body: LimitsBody | undefined) {
  return {
    expiresAt: parseExpiresAt(body?.expires_at),
    rateLimitPerMinute: parseRateLimit(body?.rate_limit_per_minute),
    monthlyQuota: parseMonthlyQuota(body?.monthly_quota),
  };
}

@Controller("admin/api/api-keys")
@UseGuards(AuthGuard)
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  async list() {
    const keys = await this.keys.listApiKeys();
    // Used-this-month comes from the quota counters, as of their last flush (a few seconds).
    const usage = await this.keys.quotaUsage(keys);
    return {
      data: keys.map((key) => ({
        ...sanitizeKey(key),
        quota_used: key.monthly_quota === null ? null : (usage.get(key.id) ?? 0),
      })),
    };
  }

  @Get(":id")
  async get(@Param("id") id: string) {
    const key = await this.keys.getApiKeyById(id);
    if (!key) apiError(404, "API key not found");
    return { data: sanitizeKey(key) };
  }

  @Post()
  async create(@Body() body: LimitsBody & { name?: unknown }) {
    if (typeof body.name !== "string" || !body.name) apiError(400, "name is required");
    return { data: await this.keys.createApiKey(body.name, parseLimits(body)) };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: LimitsBody) {
    const limits = parseLimits(body);
    if (
      limits.expiresAt === undefined &&
      limits.rateLimitPerMinute === undefined &&
      limits.monthlyQuota === undefined
    )
      apiError(400, "expires_at, rate_limit_per_minute, or monthly_quota is required");
    const updated = await this.keys.updateApiKeyLimits(id, limits);
    if (!updated) apiError(404, "API key not found");
    return { data: sanitizeKey(updated) };
  }

  @Delete(":id")
  async revoke(@Param("id") id: string) {
    const revoked = await this.keys.revokeApiKey(id);
    if (!revoked) apiError(404, "API key not found");
    return { data: sanitizeKey(revoked) };
  }
}
