import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiKeysService,
  UserApiKeyLimitError,
  UserInactiveError,
} from "../api-keys/api-keys.service";
import type { ApiKeyRecord } from "../api-keys/api-keys.service";
import type { RequestWithContext } from "../common/types";
import { apiError } from "../common/http";
import { UserGuard } from "../portal-auth/user.guard";
import { UsersService } from "../users/users.service";
import { effectiveLimits } from "../users/user-limits";
import { parseName } from "./portal-validation";

/** The key as shown to its owner: no hash, no stored value. */
function present(key: Omit<ApiKeyRecord, "key_hash" | "key_value" | "owner_active" | "user_id">) {
  return {
    id: key.id,
    name: key.name,
    key_prefix: key.key_prefix,
    created_at: key.created_at,
    last_used_at: key.last_used_at,
    expires_at: key.expires_at,
    rate_limit_per_minute: key.rate_limit_per_minute,
  };
}

function parseExpiresAt(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") apiError(400, "expires_at must be an ISO timestamp or null");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) apiError(400, "expires_at must be a valid ISO timestamp");
  if (date.getTime() <= Date.now()) apiError(400, "expires_at must be in the future");
  return date;
}

/** A portal user's own virtual API keys, used to call `/v1` and `/v2` with their own Cloud keys. */
@Controller("portal/api/api-keys")
@UseGuards(UserGuard)
export class PortalApiKeysController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly users: UsersService,
  ) {}

  @Get()
  async list(@Req() request: RequestWithContext) {
    const userId = request.user!.id;
    const [keys, limits] = await Promise.all([
      this.keys.listUserApiKeys(userId),
      this.users.limitsFor(userId).then(effectiveLimits),
    ]);
    return { data: keys.map(present), limits: this.present(limits) };
  }

  /** The plaintext `key` is returned here and never again; only its hash is stored. */
  @Post()
  async create(
    @Req() request: RequestWithContext,
    @Body() body: { name?: unknown; expires_at?: unknown } | undefined,
  ) {
    const name = parseName(body?.name);
    const expiresAt = parseExpiresAt(body?.expires_at);
    try {
      const created = await this.keys.createUserApiKey(request.user!.id, name, { expiresAt });
      return { data: { ...present(created), key: created.key } };
    } catch (error) {
      if (error instanceof UserApiKeyLimitError)
        apiError(409, `You can have at most ${error.limit} active API keys. Revoke one first.`);
      if (error instanceof UserInactiveError) apiError(403, "This account is disabled.");
      throw error;
    }
  }

  @Delete(":id")
  async revoke(@Req() request: RequestWithContext, @Param("id") id: string) {
    const revoked = await this.keys.revokeUserApiKey(request.user!.id, id);
    if (!revoked) apiError(404, "API key not found");
    return { data: present(revoked) };
  }

  private present(limits: ReturnType<typeof effectiveLimits>) {
    return {
      max_keys: limits.maxApiKeys,
      rate_limit_per_minute: limits.rateLimitPerMinute,
      monthly_quota: limits.monthlyQuota,
    };
  }
}
