import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { RequestWithContext } from "../common/types";
import { apiError } from "../common/http";
import { UserGuard } from "../portal-auth/user.guard";
import {
  MAX_USER_CLOUD_KEYS,
  UserCloudKeyError,
  UserCloudKeysService,
  type CloudKeyRole,
} from "../user-cloud-keys/user-cloud-keys.service";
import { parseName } from "./portal-validation";

/** Printable ASCII without whitespace, so the key is a valid Authorization header value. */
const KEY_PATTERN = /^[\x21-\x7e]{8,255}$/;

function parseRole(value: unknown): CloudKeyRole | undefined {
  if (value === undefined) return undefined;
  if (value !== "cloud" && value !== "fallback")
    apiError(400, 'role must be "cloud" or "fallback"');
  return value;
}

function fail(error: unknown): never {
  if (error instanceof UserCloudKeyError) {
    switch (error.reason) {
      case "limit_reached":
        return apiError(
          409,
          `You can store at most ${MAX_USER_CLOUD_KEYS} Firecrawl Cloud API keys. Remove one first.`,
        );
      case "duplicate":
        return apiError(409, "This Firecrawl Cloud API key is already added.");
      case "invalid_key":
        return apiError(400, "Firecrawl Cloud rejected this API key.");
      case "unverifiable":
        return apiError(
          502,
          "Could not reach Firecrawl Cloud to check this key. Nothing was saved; try again.",
        );
      case "verify_too_soon":
        return apiError(429, "This key was just checked. Wait a few seconds and try again.");
      case "account_inactive":
        return apiError(403, "This account is disabled.");
      case "unreadable":
        return apiError(409, "This stored key can no longer be read. Remove it and add it again.");
    }
  }
  throw error;
}

/**
 * A portal user's own Firecrawl Cloud API keys (bring your own key). They are
 * encrypted at rest, never returned, and used only for that user's virtual keys.
 */
@Controller("portal/api/cloud-keys")
@UseGuards(UserGuard)
export class PortalCloudKeysController {
  constructor(private readonly cloudKeys: UserCloudKeysService) {}

  @Get()
  async list(@Req() request: RequestWithContext) {
    return {
      data: await this.cloudKeys.list(request.user!.id),
      limits: { max_keys: MAX_USER_CLOUD_KEYS },
    };
  }

  /** Cloud must accept the key before it is stored. */
  @Post()
  async add(
    @Req() request: RequestWithContext,
    @Body() body: { name?: unknown; key?: unknown; role?: unknown } | undefined,
  ) {
    const name = parseName(body?.name);
    const key = typeof body?.key === "string" ? body.key.trim() : "";
    if (!KEY_PATTERN.test(key)) apiError(400, "key must be a Firecrawl API key");
    const role = parseRole(body?.role) ?? "cloud";
    try {
      return { data: await this.cloudKeys.add(request.user!.id, { name, key, role }) };
    } catch (error) {
      return fail(error);
    }
  }

  @Patch(":id")
  async update(
    @Req() request: RequestWithContext,
    @Param("id") id: string,
    @Body() body: { name?: unknown; role?: unknown } | undefined,
  ) {
    const name = body?.name === undefined ? undefined : parseName(body.name);
    const role = parseRole(body?.role);
    if (name === undefined && role === undefined) apiError(400, "name or role is required");
    const updated = await this.cloudKeys.update(request.user!.id, id, { name, role });
    if (!updated) apiError(404, "Cloud API key not found");
    return { data: updated };
  }

  /** Re-checks the key with Cloud now; a key whose credits came back is used again. */
  @Post(":id/verify")
  async verify(@Req() request: RequestWithContext, @Param("id") id: string) {
    try {
      const status = await this.cloudKeys.verify(request.user!.id, id);
      if (!status) apiError(404, "Cloud API key not found");
      return { data: status };
    } catch (error) {
      return fail(error);
    }
  }

  @Delete(":id")
  async remove(@Req() request: RequestWithContext, @Param("id") id: string) {
    if (!(await this.cloudKeys.remove(request.user!.id, id)))
      apiError(404, "Cloud API key not found");
    return { success: true };
  }
}
