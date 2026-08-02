import type { Request, Response } from "express";
import type { GatewayToken, User } from "../types";
import { recordSecurityEvent } from "../auth/security";
import { verifySensitiveAction } from "../auth/reauth";
import * as apiKeyService from "./service";

const DEFAULT_MAX_USER_TOKEN_RETENTION_SECONDS = 365 * 24 * 60 * 60;

export interface ApiKeyControllerOptions {
  requireReauthentication?: boolean;
  maxLifetimeSeconds?: number;
  authEncryptionKey?: string;
}

function authKey(options: ApiKeyControllerOptions): string {
  return options.authEncryptionKey || process.env.AUTH_ENCRYPTION_KEY || "";
}

async function reauthenticate(req: Request, res: Response, options: ApiKeyControllerOptions): Promise<boolean> {
  if (!options.requireReauthentication) return true;
  const result = await verifySensitiveAction(currentUser(req), req.body, authKey(options));
  if (result.ok) return true;
  res.status(401).json({ success: false, error: result.error });
  return false;
}

function currentUser(req: Request): User {
  return req.user as User;
}

export async function listApiKeys(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const isPlatformAdmin = user.platform_role === "admin" || user.is_admin;
  const keys = await apiKeyService.listApiKeys(isPlatformAdmin ? undefined : user.id);
  res.json({ data: keys.map(sanitizeGatewayToken) });
}

export async function listOwnApiKeys(req: Request, res: Response): Promise<void> {
  const keys = await apiKeyService.listApiKeys(currentUser(req).id);
  res.json({ data: keys.map(sanitizeGatewayToken) });
}

export async function getOwnApiKey(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const key = await apiKeyService.getApiKeyById(String(req.params.id), user.account_id);
  if (!key) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  if (key.user_id !== user.id) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  res.json({ data: sanitizeGatewayToken(key) });
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

export async function revokeOwnApiKey(req: Request, res: Response, options: ApiKeyControllerOptions = {}): Promise<void> {
  const user = currentUser(req);
  const id = String(req.params.id);
  const key = await apiKeyService.getApiKeyById(id, user.account_id);
  if (!key || key.user_id !== user.id) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  if (!(await reauthenticate(req, res, options))) return;
  const revoked = await apiKeyService.revokeApiKey(id, user.account_id);
  if (!revoked) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  if (user.auth_version !== undefined) {
    await recordSecurityEvent({ userId: user.id, type: "gateway_token_revoked", ip: req.ip, userAgent: req.get("user-agent"), metadata: { token_id: id } });
  }
  res.json({ data: sanitizeGatewayToken(revoked) });
}

export async function createApiKey(req: Request, res: Response, options: ApiKeyControllerOptions = {}): Promise<void> {
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
  const maxRetentionSeconds = options.maxLifetimeSeconds ?? DEFAULT_MAX_USER_TOKEN_RETENTION_SECONDS;
  const maxRetentionDays = Math.max(1, Math.floor(maxRetentionSeconds / (24 * 60 * 60)));
  if (typeof expiresAt === "string" && (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + maxRetentionSeconds * 1000)) {
    res.status(400).json({ success: false, error: `expiresAt must be within the next ${maxRetentionDays} days` });
    return;
  }
  if (inactivityTimeoutSeconds !== undefined && (typeof inactivityTimeoutSeconds !== "number" || !Number.isInteger(inactivityTimeoutSeconds) || inactivityTimeoutSeconds <= 0 || inactivityTimeoutSeconds > maxRetentionSeconds)) {
    res.status(400).json({ success: false, error: `inactivityTimeoutSeconds must be between 1 second and ${maxRetentionDays} days` });
    return;
  }
  if (user.email_verified_at === null) {
    res.status(403).json({ success: false, error: "Email verification is required" });
    return;
  }
  if (!(await reauthenticate(req, res, options))) return;
  const created = await apiKeyService.createApiKey(user.id, name.trim(), {
    scopes: scopes as string[] | undefined,
    expiresAt: (expiresAt as string | undefined) ?? null,
    inactivityTimeoutSeconds: (inactivityTimeoutSeconds as number | undefined) ?? null,
  });
  if (user.auth_version !== undefined) {
    await recordSecurityEvent({ userId: user.id, type: "gateway_token_created", ip: req.ip, userAgent: req.get("user-agent"), metadata: { token_id: created.id } });
  }
  res.status(201).json({ data: { ...created, status: created.status ?? "active" } });
}

export async function revokeApiKey(req: Request, res: Response, options: ApiKeyControllerOptions = {}): Promise<void> {
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
  if (!(await reauthenticate(req, res, options))) return;
  const revoked = user.account_id
    ? await apiKeyService.revokeApiKey(id, user.account_id)
    : await apiKeyService.revokeApiKey(id);
  if (!revoked) {
    res.status(404).json({ success: false, error: "Gateway token not found" });
    return;
  }
  if (user.auth_version !== undefined) {
    await recordSecurityEvent({ userId: user.id, type: "gateway_token_revoked", ip: req.ip, userAgent: req.get("user-agent"), metadata: { token_id: id } });
  }
  res.json({ data: sanitizeGatewayToken(revoked) });
}

export function sanitizeGatewayToken(token: GatewayToken) {
  const { key_hash: _keyHash, key_value: _legacyCiphertext, ...safe } = token;
  let status: NonNullable<GatewayToken["status"]> = "active";
  const now = Date.now();
  if (token.revoked) status = "revoked";
  else if (token.expires_at && Date.parse(token.expires_at) <= now) status = "expired";
  else if (token.inactivity_timeout_seconds !== null && token.inactivity_timeout_seconds !== undefined) {
    const lastUsed = token.last_used_at ? Date.parse(token.last_used_at) : Date.parse(token.created_at);
    if (lastUsed + token.inactivity_timeout_seconds * 1000 <= now) status = "inactive";
  }
  return { ...safe, status };
}
