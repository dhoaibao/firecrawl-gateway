import type { Request, Response } from "express";
import type { GatewayToken, User } from "../types";
import * as apiKeyService from "./service";

function currentUser(req: Request): User {
  return req.user as User;
}

export async function listApiKeys(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const isPlatformAdmin = user.platform_role === "admin" || user.is_admin;
  const keys = await apiKeyService.listApiKeys(isPlatformAdmin ? undefined : user.id);
  res.json({ data: keys.map(sanitizeGatewayToken) });
}

export async function getApiKey(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const id = String(req.params.id);
  const key = user.account_id
    ? await apiKeyService.getApiKeyById(id, user.account_id)
    : await apiKeyService.getApiKeyById(id);
  if (!key) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  if (key.user_id !== user.id) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  res.json({ data: sanitizeGatewayToken(key) });
}

export async function createApiKey(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const { name, scopes, expiresAt, inactivityTimeoutSeconds } = req.body as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ success: false, error: "name is required" });
    return;
  }
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string"))) {
    res.status(400).json({ success: false, error: "scopes must be an array of strings" });
    return;
  }
  if (expiresAt !== undefined && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)))) {
    res.status(400).json({ success: false, error: "expiresAt must be an ISO timestamp" });
    return;
  }
  if (inactivityTimeoutSeconds !== undefined && (typeof inactivityTimeoutSeconds !== "number" || !Number.isInteger(inactivityTimeoutSeconds) || inactivityTimeoutSeconds <= 0)) {
    res.status(400).json({ success: false, error: "inactivityTimeoutSeconds must be a positive integer" });
    return;
  }
  if (user.email_verified_at === null) {
    res.status(403).json({ success: false, error: "Email verification is required" });
    return;
  }
  const created = await apiKeyService.createApiKey(user.id, name.trim(), {
    scopes: scopes as string[] | undefined,
    expiresAt: (expiresAt as string | undefined) ?? null,
    inactivityTimeoutSeconds: (inactivityTimeoutSeconds as number | undefined) ?? null,
  });
  res.status(201).json({ data: created });
}

export async function revokeApiKey(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const id = String(req.params.id);
  const key = user.account_id
    ? await apiKeyService.getApiKeyById(id, user.account_id)
    : await apiKeyService.getApiKeyById(id);
  if (!key) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  if (key.user_id !== user.id) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return;
  }
  const revoked = user.account_id
    ? await apiKeyService.revokeApiKey(id, user.account_id)
    : await apiKeyService.revokeApiKey(id);
  if (!revoked) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  res.json({ data: sanitizeGatewayToken(revoked) });
}

export function sanitizeGatewayToken(token: GatewayToken) {
  const { key_hash: _keyHash, key_value: _legacyCiphertext, ...safe } = token;
  return safe;
}
