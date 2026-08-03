import { json, Router, type Request, type Response } from "express";
import type { GatewayConfig, User } from "./types";
import { asyncHandler } from "./infrastructure/http/async-handler";
import { requireOperatorMfa } from "./auth/middleware";
import { verifySensitiveAction } from "./auth/reauth";
import { getMfaState, listSessions, revokeAllSessions } from "./auth/security";
import * as userService from "./users/service";
import { serializeUser } from "./users/serialization";
import * as apiKeyService from "./api-keys/service";
import { sanitizeGatewayToken } from "./api-keys/controllers";
import * as credentialRepository from "./credentials/repository";
import * as sourceRepository from "./sources/repository";
import { createQuotaRouter } from "./quota/routes";
import * as settingsService from "./settings/service";
import { withOperatorTransaction } from "./infrastructure/database";
import { getOperatorAnalytics } from "./operator-analytics";
import { listNotifications, syncQuotaNotifications, updateNotificationState } from "./operator-notifications";
import { operatorAuditMiddleware, operatorReason, requireReason } from "./operator-audit";

const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

function actor(req: Request): User {
  return req.user as User;
}

function requirePlatformOperator(req: Request, res: Response, next: () => void): void {
  const user = req.user as User | undefined;
  if (!user || user.platform_role !== "admin") {
    res.status(403).json({ success: false, error: "An active operator role is required" });
    return;
  }
  next();
}

function requireStepUp(req: Request, res: Response, next: () => void): void {
  const stepUpAt = (req.session as typeof req.session & { operatorStepUpAt?: number }).operatorStepUpAt;
  if (!stepUpAt || Date.now() - stepUpAt > STEP_UP_WINDOW_MS) {
    res.status(403).json({ success: false, error: "Recent password and MFA step-up is required", code: "step_up_required" });
    return;
  }
  next();
}

function mutationGuards(req: Request, res: Response, next: () => void): void {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    requireReason(req, res, () => requireStepUp(req, res, next));
    return;
  }
  next();
}

function accountIdFor(userId: string): string {
  return `personal:${userId}`;
}

export function createOperatorRouter(config: GatewayConfig, checkDatabase?: () => Promise<boolean>) {
  const router = Router();
  router.use(json({ limit: "64kb" }));
  router.use(operatorAuditMiddleware);
  router.use(requirePlatformOperator);
  router.use(requireOperatorMfa);
  if (checkDatabase) {
    router.use((req, res, next) => {
      void checkDatabase().then((ready) => {
        if (ready) { next(); return; }
        res.status(503).json({ success: false, error: "Operator database prerequisites are unavailable", code: "operator_read_only", data: { service: "operator-console", read_only: true, method: req.method } });
      }).catch(() => {
        res.status(503).json({ success: false, error: "Operator database prerequisites are unavailable", code: "operator_read_only", data: { service: "operator-console", read_only: true, method: req.method } });
      });
    });
  }

  router.post("/step-up", asyncHandler(async (req: Request, res: Response) => {
    const result = await verifySensitiveAction(actor(req), req.body, config.authEncryptionKey || process.env.AUTH_ENCRYPTION_KEY || "");
    if (!result.ok) {
      res.status(401).json({ success: false, error: result.error, code: "step_up_failed" });
      return;
    }
    (req.session as typeof req.session & { operatorStepUpAt?: number }).operatorStepUpAt = Date.now();
    await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
    res.json({ success: true, expires_at: new Date(Date.now() + STEP_UP_WINDOW_MS).toISOString() });
  }));

  router.get("/", asyncHandler(async (_req, res) => {
    res.json({ data: { service: "operator-console", read_only: false, utc: new Date().toISOString() } });
  }));

  router.get("/capacity", asyncHandler(async (_req, res) => {
    const quotaService = await import("./quota/service");
    res.json({ data: await quotaService.getPolicySummary() });
  }));

  // Phase 5 owns the invariant checks; this boundary adds operator-only MFA,
  // step-up, reason, and audit requirements.
  router.use("/capacity", mutationGuards, createQuotaRouter());

  router.get("/accounts", asyncHandler(async (req, res) => {
    const verified = typeof req.query.verified === "string" ? req.query.verified === "true" : undefined;
    const result = await userService.searchUsers({
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      verified,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ data: result.users.map(serializeUser), pagination: { total: result.total, limit: Math.min(Number(req.query.limit) || 50, 100) } });
  }));

  router.get("/accounts/:id", asyncHandler(async (req, res) => {
    const user = await userService.getUserById(String(req.params.id));
    if (!user) { res.status(404).json({ success: false, error: "Account not found" }); return; }
    const accountId = accountIdFor(user.id);
    const [tokens, credentials, sessions, quota] = await Promise.all([
      apiKeyService.listApiKeys(user.id),
      credentialRepository.listAccountCredentialMetadata(accountId),
      listSessions(user.id),
      import("./quota/service").then((quotaService) => quotaService.getAccountQuota(accountId)),
    ]);
    res.json({ data: {
      identity: serializeUser(user), account_id: accountId, endpoint_id: accountId,
      tokens: tokens.map(sanitizeGatewayToken), credentials, sessions, quota,
      security: { mfa: await getMfaState(user.id) },
    } });
  }));

  router.post("/accounts/:id/suspend", mutationGuards, asyncHandler(async (req, res) => {
    const targetId = String(req.params.id);
    if (targetId === actor(req).id) { res.status(400).json({ success: false, error: "Operators cannot suspend themselves" }); return; }
    const duration = Math.min(Math.max(Number(req.body.duration_ms) || 24 * 60 * 60 * 1000, 60_000), 365 * 24 * 60 * 60 * 1000);
    const user = await userService.suspendUser(targetId, duration);
    if (!user) { res.status(404).json({ success: false, error: "Account not found" }); return; }
    res.json({ data: serializeUser(user), reason: operatorReason(req) });
  }));

  router.post("/accounts/:id/block", mutationGuards, asyncHandler(async (req, res) => {
    if (String(req.params.id) === actor(req).id) { res.status(400).json({ success: false, error: "Operators cannot block themselves" }); return; }
    const user = await userService.blockUser(String(req.params.id));
    if (!user) { res.status(404).json({ success: false, error: "Account not found" }); return; }
    res.json({ data: serializeUser(user) });
  }));

  router.post("/accounts/:id/reactivate", mutationGuards, asyncHandler(async (req, res) => {
    const user = await userService.activateUser(String(req.params.id));
    if (!user) { res.status(404).json({ success: false, error: "Account not found" }); return; }
    res.json({ data: serializeUser(user) });
  }));

  router.post("/accounts/:id/free-tier/revoke", mutationGuards, asyncHandler(async (req, res) => {
    const quotaService = await import("./quota/service");
    const result = await quotaService.revokeFreeTier(accountIdFor(String(req.params.id)), actor(req).email, operatorReason(req));
    res.json({ data: result });
  }));

  router.post("/accounts/:id/sessions/revoke-all", mutationGuards, asyncHandler(async (req, res) => {
    const target = await userService.getUserById(String(req.params.id));
    if (!target) { res.status(404).json({ success: false, error: "Account not found" }); return; }
    await revokeAllSessions(target.id);
    res.json({ success: true });
  }));

  router.post("/accounts/:id/tokens/revoke-all", mutationGuards, asyncHandler(async (req, res) => {
    const tokens = await apiKeyService.listApiKeys(String(req.params.id));
    await Promise.all(tokens.filter((token) => !token.revoked).map((token) => apiKeyService.revokeApiKey(token.id, accountIdFor(String(req.params.id)))));
    res.json({ success: true, revoked: tokens.filter((token) => !token.revoked).length });
  }));

  router.delete("/accounts/:id", mutationGuards, asyncHandler(async (req, res) => {
    if (String(req.params.id) === actor(req).id) { res.status(400).json({ success: false, error: "Operators cannot delete themselves" }); return; }
    const result = await userService.deleteUserSafely(String(req.params.id));
    if (result === "last_admin") { res.status(409).json({ success: false, error: "The last operator cannot be deleted" }); return; }
    if (result === "not_found") { res.status(404).json({ success: false, error: "Account not found" }); return; }
    res.json({ success: true });
  }));

  router.get("/infrastructure", asyncHandler(async (_req, res) => {
    const sources = await sourceRepository.listInfrastructureSources();
    res.json({ data: sources.map((source) => ({ ...source, consumed: null, budget: source.monthly_budget_cents, concurrency: source.hard_concurrency, latency_ms: null })) });
  }));

  router.post("/infrastructure", mutationGuards, asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    if (typeof body.id !== "string" || typeof body.name !== "string" || !["cloud", "self_hosted"].includes(body.kind)) {
      res.status(400).json({ success: false, error: "id, name, and a valid kind are required" }); return;
    }
    const source = await sourceRepository.createInfrastructureSource({ ...body, id: body.id.trim(), name: body.name.trim(), kind: body.kind });
    res.status(201).json({ data: source });
  }));

  router.patch("/infrastructure/:id", mutationGuards, asyncHandler(async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    if (body.status !== undefined && !sourceRepository.isSourceStatus(body.status)) {
      res.status(400).json({ success: false, error: "Unsupported infrastructure source status" });
      return;
    }
    const source = await sourceRepository.updateInfrastructureSource(String(req.params.id), body);
    if (!source) { res.status(404).json({ success: false, error: "Infrastructure source not found" }); return; }
    res.json({ data: source });
  }));

  router.post("/infrastructure/:id/test", mutationGuards, asyncHandler(async (req, res) => {
    const source = (await sourceRepository.listInfrastructureSources()).find((item) => item.id === String(req.params.id));
    if (!source) { res.status(404).json({ success: false, error: "Infrastructure source not found" }); return; }
    if (!source.base_url) { res.json({ data: { status: "advisory", message: "Cloud source health is reported by the provider" } }); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${source.base_url}/health`, { signal: controller.signal });
      res.json({ data: { status: response.ok ? "healthy" : "unhealthy", http_status: response.status } });
    } finally { clearTimeout(timer); }
  }));

  router.post("/infrastructure/:id/:action", mutationGuards, asyncHandler(async (req, res) => {
    const action = String(req.params.action);
    const status = action === "drain" ? "draining" : action === "pause" ? "paused" : action === "activate" ? "active" : null;
    if (!status) { res.status(404).json({ success: false, error: "Unsupported source action" }); return; }
    const source = await sourceRepository.updateInfrastructureSource(String(req.params.id), { status });
    if (!source) { res.status(404).json({ success: false, error: "Infrastructure source not found" }); return; }
    res.json({ data: source });
  }));

  router.put("/infrastructure/credentials/:id", mutationGuards, asyncHandler(async (req, res) => {
    if (typeof req.body?.value !== "string" || !req.body.value.trim() || typeof req.body?.source_id !== "string") { res.status(400).json({ success: false, error: "value and source_id are required" }); return; }
    const credential = await credentialRepository.replaceOperatorCredential(String(req.params.id), { value: req.body.value.trim(), purpose: req.body.purpose === "self_hosted_upstream" ? "self_hosted_upstream" : "firecrawl_cloud", sourceId: req.body.source_id, keyVersion: 1, providerMetadata: {} }, config.providerCredentialsEncryptionKey ?? config.firecrawlKeysEncryptionKey);
    if (!credential) { res.status(404).json({ success: false, error: "Credential not found" }); return; }
    res.status(201).json({ data: credential });
  }));

  router.delete("/infrastructure/credentials/:id", mutationGuards, asyncHandler(async (req, res) => {
    const revoked = await credentialRepository.revokeOperatorCredential(String(req.params.id));
    if (!revoked) { res.status(404).json({ success: false, error: "Credential not found" }); return; }
    res.json({ success: true });
  }));

  router.get("/infrastructure/credentials", asyncHandler(async (_req, res) => {
    const credentials = await withOperatorTransaction((tx) => tx.providerCredential.findMany({
      where: { ownerType: "operator" }, orderBy: { createdAt: "desc" },
      select: { id: true, ownerType: true, accountId: true, purpose: true, keyVersion: true, maskedPrefix: true, maskedSuffix: true, status: true, providerMetadata: true, lastValidatedAt: true, lastUsedAt: true, supersededAt: true, createdAt: true, updatedAt: true },
    }));
    res.json({ data: credentials.map((row) => ({ id: row.id, owner_type: row.ownerType, account_id: row.accountId, purpose: row.purpose, key_version: row.keyVersion, masked_prefix: row.maskedPrefix, masked_suffix: row.maskedSuffix, status: row.status, provider_metadata: row.providerMetadata, last_validated_at: row.lastValidatedAt?.toISOString() ?? null, last_used_at: row.lastUsedAt?.toISOString() ?? null, superseded_at: row.supersededAt?.toISOString() ?? null, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() })) });
  }));

  router.post("/infrastructure/credentials", mutationGuards, asyncHandler(async (req, res) => {
    if (typeof req.body?.value !== "string" || !req.body.value.trim() || typeof req.body?.source_id !== "string" || !req.body.source_id.trim()) { res.status(400).json({ success: false, error: "value and source_id are required" }); return; }
    const credential = await credentialRepository.createOperatorCredential({ value: req.body.value.trim(), purpose: req.body.purpose === "self_hosted_upstream" ? "self_hosted_upstream" : "firecrawl_cloud", sourceId: req.body.source_id.trim(), keyVersion: 1, providerMetadata: {} }, config.providerCredentialsEncryptionKey ?? config.firecrawlKeysEncryptionKey);
    res.status(201).json({ data: credential });
  }));

  router.get("/usage", asyncHandler(async (req, res) => res.json({ data: await getOperatorAnalytics({ from: typeof req.query.from === "string" ? req.query.from : undefined, to: typeof req.query.to === "string" ? req.query.to : undefined }) })));
  router.get("/requests", asyncHandler(async (req, res) => res.json({ data: await getOperatorAnalytics({ from: typeof req.query.from === "string" ? req.query.from : undefined, to: typeof req.query.to === "string" ? req.query.to : undefined }) })));

  router.get("/notifications", asyncHandler(async (req, res) => {
    await syncQuotaNotifications(config);
    const state = ["active", "acknowledged", "resolved"].includes(String(req.query.state)) ? String(req.query.state) as "active" | "acknowledged" | "resolved" : undefined;
    res.json({ data: await listNotifications({ state, limit: Number(req.query.limit) || 50 }) });
  }));
  router.post("/notifications/:id/acknowledge", mutationGuards, asyncHandler(async (req, res) => {
    const updated = await updateNotificationState(String(req.params.id), "acknowledged", actor(req).email);
    if (!updated) { res.status(404).json({ success: false, error: "Notification not found" }); return; }
    res.json({ success: true });
  }));
  router.post("/notifications/:id/resolve", mutationGuards, asyncHandler(async (req, res) => {
    const updated = await updateNotificationState(String(req.params.id), "resolved", actor(req).email);
    if (!updated) { res.status(404).json({ success: false, error: "Notification not found" }); return; }
    res.json({ success: true });
  }));

  router.get("/security", asyncHandler(async (req, res) => {
    const userId = typeof req.query.user_id === "string" ? req.query.user_id : undefined;
    const events = await withOperatorTransaction((tx) => tx.securityEvent.findMany({ where: userId ? { userId } : undefined, orderBy: { createdAt: "desc" }, take: Math.min(Number(req.query.limit) || 100, 100) }));
    res.json({ data: events.map((event) => ({ id: event.id, user_id: event.userId, event_type: event.eventType, created_at: event.createdAt.toISOString(), metadata: event.metadata })) });
  }));

  router.get("/configuration", asyncHandler(async (_req, res) => {
    const rows = await settingsService.listSettings();
    res.json({ data: rows.map((row) => ({ key: row.key, configured: Boolean(row.value), value: ["default_route_mode", "api_key_inactivity_revoke_days"].includes(row.key) ? row.value : undefined })) });
  }));
  router.put("/configuration", mutationGuards, asyncHandler(async (req, res) => {
    const allowed = new Set(["default_route_mode", "api_key_inactivity_revoke_days"]);
    const updates = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(updates)) {
      if (!allowed.has(key) || typeof value !== "string" && typeof value !== "number") { res.status(400).json({ success: false, error: `Unsupported or invalid configuration key: ${key}` }); return; }
      await settingsService.setSetting(key, String(value));
    }
    res.json({ success: true });
  }));

  return router;
}
