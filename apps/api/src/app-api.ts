import crypto from "node:crypto";
import { json, Router, type Request, type Response } from "express";
import { Prisma } from "@prisma/client";
import type { GatewayConfig, User } from "./types";
import { withAccountTransaction, withOperatorTransaction } from "./infrastructure/database";
import { asyncHandler } from "./infrastructure/http/async-handler";
import * as accountRepository from "./db/accounts";
import * as quotaService from "./quota/service";
import * as apiKeyService from "./api-keys/service";
import * as credentialRepository from "./credentials/repository";
import { sanitizeGatewayToken } from "./api-keys/controllers";
import { serializeUser } from "./users/serialization";
import * as userService from "./users/service";
import { privacyLabel, recordSecurityEvent } from "./auth/security";
import { verifySensitiveAction } from "./auth/reauth";
import { queueEmail } from "./auth/email";
import { escapeHtml } from "./utils";

const MAX_EXPORT_AUDIT_ROWS = 10_000;

const auditSelect = {
  id: true,
  createdAt: true,
  method: true,
  path: true,
  backendUsed: true,
  fundingType: true,
  statusCode: true,
  durationMs: true,
  requestId: true,
} satisfies Prisma.AuditLogSelect;

type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>;
type FundingType = "included" | "byok" | "unknown";

function currentUser(req: Request): User {
  return req.user as User;
}

function accountIdFor(req: Request): string {
  const accountId = currentUser(req).account_id;
  if (!accountId) {
    const error = new Error("An account is required") as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  return accountId;
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pageNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}

function pageSize(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 25;
}

function publicUser(user: User) {
  const { account_id: _accountId, ...safe } = serializeUser(user);
  return safe;
}

function publicAccount(account: accountRepository.AccountRecord) {
  return {
    public_id: account.public_id,
    display_name: account.display_name,
    status: account.status,
    funding_preference: account.funding_preference,
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

function endpointView(account: accountRepository.AccountRecord) {
  return {
    endpoint_id: account.public_id,
    base_path: `/e/${encodeURIComponent(account.public_id)}`,
    immutable: true,
    status: account.status === "active" ? "active" : "unavailable",
  };
}

function fundingType(value: string | null | undefined): FundingType {
  return value === "included" || value === "byok" ? value : "unknown";
}

function routeFamily(path: string): string {
  const match = path.match(/^\/(v[12])\/([^/?]+)/i);
  return match ? `/${match[1].toLowerCase()}/${match[2]}` : "/unknown";
}

function statusBucket(statusCode: number): "2xx" | "4xx" | "5xx" | "other" {
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "other";
}

function periodBounds(period: string | undefined): { gte?: Date; lt?: Date } {
  if (!period || period === "all") return {};
  const now = new Date();
  if (period === "7d" || period === "week") return { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) };
  if (period === "30d" || period === "month") return { gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) };
  if (/^\d{4}-\d{2}$/.test(period)) {
    const start = new Date(`${period}-01T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime())) {
      return { gte: start, lt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
    }
  }
  return {};
}

interface AuditQuery {
  page: number;
  pageSize: number;
  period?: string;
  status?: string;
  latency?: string;
  fundingType?: string;
  routeFamily?: string;
}

async function listAccountAudit(accountId: string, query: AuditQuery): Promise<{ rows: AuditRow[]; total: number }> {
  const where: Prisma.AuditLogWhereInput = { accountId };
  const bounds = periodBounds(query.period);
  if (bounds.gte || bounds.lt) where.createdAt = bounds;
  if (query.status === "2xx") where.statusCode = { gte: 200, lt: 300 };
  if (query.status === "4xx") where.statusCode = { gte: 400, lt: 500 };
  if (query.status === "5xx") where.statusCode = { gte: 500, lt: 600 };
  if (query.latency === "fast") where.durationMs = { lt: 500 };
  if (query.latency === "standard") where.durationMs = { gte: 500, lt: 2_000 };
  if (query.latency === "slow") where.durationMs = { gte: 2_000 };
  if (query.fundingType === "included" || query.fundingType === "byok" || query.fundingType === "unknown") {
    where.fundingType = query.fundingType;
  }
  const requestedRouteFamily = query.routeFamily?.replace(/\/+$/, "");
  if (requestedRouteFamily && /^\/v[12]\/[^/?]+$/i.test(requestedRouteFamily)) {
    where.OR = [
      { path: requestedRouteFamily },
      { path: { startsWith: `${requestedRouteFamily}/` } },
    ];
  }

  return withAccountTransaction(accountId, async (tx) => {
    const [rows, total] = await Promise.all([
      tx.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: auditSelect,
      }),
      tx.auditLog.count({ where }),
    ]);
    return { rows, total };
  });
}

function usageItem(row: AuditRow) {
  return {
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    route_family: routeFamily(row.path),
    funding_type: fundingType(row.fundingType),
    status: row.statusCode,
    status_bucket: statusBucket(row.statusCode),
    duration_ms: row.durationMs,
    request_id: row.requestId,
  };
}

function historyItem(row: AuditRow) {
  return {
    id: row.id,
    method: row.method,
    route_family: routeFamily(row.path),
    timestamp: row.createdAt.toISOString(),
    source_class: row.backendUsed === "self-hosted" ? "self-hosted" : row.backendUsed === "cloud" ? "cloud" : "gateway",
    funding_type: fundingType(row.fundingType),
    status: row.statusCode,
    duration_ms: row.durationMs,
    request_id: row.requestId,
    target: "redacted",
  };
}

function summaryFromRows(rows: AuditRow[]) {
  const successful = rows.filter((row) => row.statusCode >= 200 && row.statusCode < 400).length;
  const errors = rows.filter((row) => row.statusCode >= 400).length;
  const averageLatency = rows.length === 0
    ? 0
    : Math.round(rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length);
  const funding = rows.map((row) => fundingType(row.fundingType));
  return {
    requests: rows.length,
    successful,
    errors,
    average_latency_ms: averageLatency,
    included_requests: funding.filter((value) => value === "included").length,
    byok_requests: funding.filter((value) => value === "byok").length,
  };
}

function createOverviewHandler(config: GatewayConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const user = currentUser(req);
    const accountId = accountIdFor(req);
    const account = await accountRepository.getAccountByIdForTenant(accountId);
    if (!account) {
      res.status(404).json({ success: false, error: "Account unavailable" });
      return;
    }
    const quota = await quotaService.getAccountQuota(accountId);
    const audit = await listAccountAudit(accountId, { page: 1, pageSize: 50 });
    res.json({
      data: {
        user: publicUser(user),
        account: publicAccount(account),
        endpoint: endpointView(account),
        quota,
        recent: summaryFromRows(audit.rows),
        endpoint_base_url: config.publicAppUrl ? `${new URL(config.publicAppUrl).origin}${endpointView(account).base_path}` : endpointView(account).base_path,
      },
    });
  };
}

async function accountHandler(req: Request, res: Response): Promise<void> {
  const account = await accountRepository.getAccountByIdForTenant(accountIdFor(req));
  if (!account) {
    res.status(404).json({ success: false, error: "Account unavailable" });
    return;
  }
  res.json({ data: publicAccount(account) });
}

async function updateAccountHandler(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const accountId = accountIdFor(req);
  const body = req.body as Record<string, unknown>;
  const preference = body.funding_preference;
  if (preference !== undefined && !["byok", "included", "auto"].includes(String(preference))) {
    res.status(400).json({ success: false, error: "funding_preference must be byok, included, or auto" });
    return;
  }
  const name = body.name;
  if (name !== undefined && (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 255)) {
    res.status(400).json({ success: false, error: "name must be between 1 and 255 characters" });
    return;
  }

  const updatedUser = name === undefined ? user : await userService.updateUser(user.id, { name: String(name).trim() });
  if (!updatedUser) {
    res.status(404).json({ success: false, error: "Account unavailable" });
    return;
  }
  const account = await withAccountTransaction(accountId, async (tx) => tx.account.update({
    where: { id: accountId },
    data: {
      ...(preference === undefined ? {} : { fundingPreference: String(preference) }),
      ...(name === undefined ? {} : { displayName: String(name).trim() }),
      updatedAt: new Date(),
    },
    select: {
      id: true,
      publicId: true,
      displayName: true,
      status: true,
      fundingPreference: true,
      createdAt: true,
      updatedAt: true,
    },
  }));
  res.json({ data: { user: publicUser(updatedUser), account: publicAccount({
    id: account.id,
    public_id: account.publicId,
    display_name: account.displayName,
    status: account.status,
    funding_preference: account.fundingPreference as accountRepository.AccountRecord["funding_preference"],
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  }) } });
}

async function endpointHandler(req: Request, res: Response): Promise<void> {
  const account = await accountRepository.getAccountByIdForTenant(accountIdFor(req));
  if (!account) {
    res.status(404).json({ success: false, error: "Endpoint unavailable" });
    return;
  }
  res.json({ data: { ...endpointView(account), account_status: account.status } });
}

async function quotaHandler(req: Request, res: Response): Promise<void> {
  res.json({ data: await quotaService.getAccountQuota(accountIdFor(req)) });
}

async function usageHandler(req: Request, res: Response): Promise<void> {
  const account = await accountRepository.getAccountByIdForTenant(accountIdFor(req));
  if (!account) {
    res.status(404).json({ success: false, error: "Account unavailable" });
    return;
  }
  const query: AuditQuery = {
    page: pageNumber(req.query.page),
    pageSize: pageSize(req.query.page_size),
    period: queryString(req.query.period),
    status: queryString(req.query.status),
    latency: queryString(req.query.latency),
    fundingType: queryString(req.query.funding_type),
    routeFamily: queryString(req.query.route_family),
  };
  const result = await listAccountAudit(account.id, query);
  res.json({
    data: {
      items: result.rows.map(usageItem),
      pagination: { page: query.page, page_size: query.pageSize, total: result.total },
    },
  });
}

async function historyHandler(req: Request, res: Response): Promise<void> {
  const account = await accountRepository.getAccountByIdForTenant(accountIdFor(req));
  if (!account) {
    res.status(404).json({ success: false, error: "Account unavailable" });
    return;
  }
  const query: AuditQuery = {
    page: pageNumber(req.query.page),
    pageSize: pageSize(req.query.page_size),
    period: queryString(req.query.period),
    status: queryString(req.query.status),
    latency: queryString(req.query.latency),
    fundingType: queryString(req.query.funding_type),
    routeFamily: queryString(req.query.route_family),
  };
  const result = await listAccountAudit(account.id, query);
  res.json({
    data: {
      items: result.rows.map(historyItem),
      pagination: { page: query.page, page_size: query.pageSize, total: result.total },
    },
  });
}

async function securityEventsHandler(req: Request, res: Response): Promise<void> {
  const userId = currentUser(req).id;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const rows = await withOperatorTransaction((tx) => tx.securityEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, eventType: true, createdAt: true },
  }));
  res.json({ data: rows.map((row) => ({ id: row.id, event_type: row.eventType, created_at: row.createdAt.toISOString() })) });
}

async function listExportAccountAudit(accountId: string): Promise<{ rows: AuditRow[]; truncated: boolean }> {
  const pageSizeValue = 100;
  const rows: AuditRow[] = [];
  let page = 1;
  while (rows.length < MAX_EXPORT_AUDIT_ROWS) {
    const result = await listAccountAudit(accountId, {
      page,
      pageSize: Math.min(pageSizeValue, MAX_EXPORT_AUDIT_ROWS - rows.length),
    });
    rows.push(...result.rows);
    if (result.rows.length < pageSizeValue || rows.length >= result.total) {
      return { rows, truncated: false };
    }
    page += 1;
  }
  const latest = await listAccountAudit(accountId, { page: page + 1, pageSize: 1 });
  return { rows, truncated: latest.total > rows.length };
}

async function exportHandler(config: GatewayConfig, req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const reauthentication = await verifySensitiveAction(
    user,
    req.body,
    config.authEncryptionKey || process.env.AUTH_ENCRYPTION_KEY || "",
  );
  if (!reauthentication.ok) {
    res.status(401).json({ success: false, error: reauthentication.error });
    return;
  }

  const accountId = accountIdFor(req);
  const account = await accountRepository.getAccountByIdForTenant(accountId);
  if (!account) {
    res.status(404).json({ success: false, error: "Account unavailable" });
    return;
  }
  const [tokens, credentials, quota, history] = await Promise.all([
    apiKeyService.listApiKeys(user.id),
    credentialRepository.listAccountCredentialMetadata(accountId),
    quotaService.getAccountQuota(accountId),
    listExportAccountAudit(accountId),
  ]);
  await recordSecurityEvent({ userId: user.id, type: "account_exported", ip: req.ip, userAgent: req.get("user-agent") });
  res.json({
    data: {
      exported_at: new Date().toISOString(),
      user: publicUser(user),
      account: publicAccount(account),
      endpoint: endpointView(account),
      quota,
      tokens: tokens.map(sanitizeGatewayToken),
      credentials,
      request_history: history.rows.map(historyItem),
      request_history_truncated: history.truncated,
      request_history_limit: MAX_EXPORT_AUDIT_ROWS,
    },
  });
}

async function deletionRequestHandler(config: GatewayConfig, req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const reauthentication = await verifySensitiveAction(
    user,
    req.body,
    config.authEncryptionKey || process.env.AUTH_ENCRYPTION_KEY || "",
  );
  if (!reauthentication.ok) {
    res.status(401).json({ success: false, error: reauthentication.error });
    return;
  }
  const workflowId = crypto.randomUUID();
  const encryptionKey = config.authEncryptionKey || process.env.AUTH_ENCRYPTION_KEY || "";
  const userName = escapeHtml(user.name);
  const userEmail = escapeHtml(user.email);
  const accountId = accountIdFor(req);
  await withOperatorTransaction(async (tx) => {
    await tx.securityEvent.create({
      data: {
        id: crypto.randomUUID(),
        userId: user.id,
        eventType: "account_deletion_requested",
        ipLabel: privacyLabel(req.ip),
        userAgentLabel: privacyLabel(req.get("user-agent")),
        metadata: { workflow_id: workflowId, account_id: accountId },
      },
    });
    await queueEmail({
      client: tx,
      userId: user.id,
      recipient: user.email,
      kind: "account_deletion_confirmation",
      idempotencyKey: `account-deletion-confirmation:${workflowId}`,
      payload: {
        subject: "Your Firecrawl Gateway deletion request was received",
        html: `<p>Hello ${userName},</p><p>Your account deletion request was received and queued for operator review.</p><p>Reference: ${workflowId}</p><p>We will confirm which records are retained for security, billing, or legal obligations.</p>`,
      },
      encryptionKey,
    });
    if (config.adminEmail) {
      await queueEmail({
        client: tx,
        userId: user.id,
        recipient: config.adminEmail,
        kind: "account_deletion_operator_notification",
        idempotencyKey: `account-deletion-operator:${workflowId}`,
        payload: {
          subject: "Account deletion request requires operator review",
          html: `<p>A deletion request requires operator review.</p><p>User: ${userName} (${userEmail})</p><p>Account: ${escapeHtml(accountId)}</p><p>Reference: ${workflowId}</p>`,
        },
        encryptionKey,
      });
    }
  });
  res.status(202).json({
    data: {
      status: "queued",
      workflow_id: workflowId,
      retention: "Your request and confirmation email have been queued for operator review. We will confirm which records are retained for security, billing, or legal obligations.",
    },
  });
}

export function createUserPortalRouter(config: GatewayConfig) {
  const router = Router();
  router.use(json({ limit: "128kb" }));

  router.get("/overview", asyncHandler(createOverviewHandler(config)));
  router.get("/dashboard", asyncHandler(createOverviewHandler(config)));
  router.get("/account", asyncHandler(accountHandler));
  router.patch("/account", asyncHandler(updateAccountHandler));
  router.post("/account/export", asyncHandler((req, res) => exportHandler(config, req, res)));
  router.post("/account/deletion-request", asyncHandler((req, res) => deletionRequestHandler(config, req, res)));
  router.get("/endpoint", asyncHandler(endpointHandler));
  router.get("/quota", asyncHandler(quotaHandler));
  router.get("/usage", asyncHandler(usageHandler));
  router.get("/request-history", asyncHandler(historyHandler));
  router.get("/security/events", asyncHandler(securityEventsHandler));

  return router;
}
