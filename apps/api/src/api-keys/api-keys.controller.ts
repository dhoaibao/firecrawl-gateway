import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { apiError } from "../common/http";
import { AuthGuard } from "../auth/guards";
import { ApiKeysService, type ApiKeyRecord } from "./api-keys.service";

const MAX_RATE_LIMIT_PER_MINUTE = 100_000;

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

interface LimitsBody {
  expires_at?: unknown;
  rate_limit_per_minute?: unknown;
}

@Controller("admin/api/api-keys")
@UseGuards(AuthGuard)
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  async list() {
    const keys = await this.keys.listApiKeys();
    return { data: keys.map(sanitizeKey) };
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
    const limits = {
      expiresAt: parseExpiresAt(body.expires_at),
      rateLimitPerMinute: parseRateLimit(body.rate_limit_per_minute),
    };
    return { data: await this.keys.createApiKey(body.name, limits) };
  }

  @Patch(":id")
  async update(@Param("id") id: string, @Body() body: LimitsBody) {
    const limits = {
      expiresAt: parseExpiresAt(body?.expires_at),
      rateLimitPerMinute: parseRateLimit(body?.rate_limit_per_minute),
    };
    if (limits.expiresAt === undefined && limits.rateLimitPerMinute === undefined)
      apiError(400, "expires_at or rate_limit_per_minute is required");
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
