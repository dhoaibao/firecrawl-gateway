import crypto from "node:crypto";
import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { User } from "../../../types";
import { AppConfigService } from "../../../core/config/config.service";
import { TransactionService } from "../../../core/database/transaction.service";
import { encryptAuthValue } from "../../../auth/crypto";
import { privacyLabel } from "../../../auth/security";
import type { RequestMetadata } from "../../../common/http/request-context";
import { AuthService } from "../../auth/application/auth.service";
import { GatewayTokensService } from "../../gateway-tokens/application/gateway-tokens.service";
import { ProviderStoreService } from "../../integrations/application/provider-store.service";
import { QuotaService } from "../../quota/application/quota.service";

const auditSelect = Prisma.validator<Prisma.AuditLogSelect>()({ id: true, createdAt: true, method: true, path: true, backendUsed: true, fundingType: true, statusCode: true, durationMs: true, requestId: true });
type AuditRow = Prisma.AuditLogGetPayload<{ select: typeof auditSelect }>;
type SensitiveAction = { current_password: string; mfa_code?: string; recovery_code?: string };

@Injectable()
export class PortalService {
  constructor(private readonly transactions: TransactionService, private readonly quota: QuotaService, private readonly config: AppConfigService, private readonly auth: AuthService, private readonly tokens: GatewayTokensService, private readonly credentials: ProviderStoreService) {}

  async overview(user: User) { const account = await this.account(user.account_id); const [quota, audit] = await Promise.all([this.quota.getAccountQuota(account.id), this.audit(account.id, {})]); return { user: publicUser(user), account: publicAccount(account), endpoint: endpoint(account), quota, recent: summary(audit.rows), endpoint_base_url: this.config.publicAppUrl ? `${new URL(this.config.publicAppUrl).origin}${endpoint(account).base_path}` : endpoint(account).base_path }; }
  async getAccount(accountId: string) { return publicAccount(await this.account(accountId)); }
  async updateAccount(user: User, input: { name?: string; funding_preference?: "byok" | "included" | "auto" }) { const accountId = await this.requireAccountId(user); const result = await this.transactions.runForAccount(accountId, async (tx) => { const account = await tx.account.update({ where: { id: accountId }, data: { ...(input.funding_preference === undefined ? {} : { fundingPreference: input.funding_preference }), ...(input.name === undefined ? {} : { displayName: input.name }), updatedAt: new Date() }, select: { id: true, publicId: true, displayName: true, status: true, fundingPreference: true, createdAt: true, updatedAt: true } }); const updatedUser = input.name === undefined ? null : await tx.user.update({ where: { id: user.id }, data: { name: input.name }, select: { id: true, email: true, normalizedEmail: true, name: true, passwordHash: true, isAdmin: true, platformRole: true, emailVerifiedAt: true, authVersion: true, status: true, suspendedUntil: true, createdAt: true, updatedAt: true } }); return { account, updatedUser }; }); return { account: publicAccount(result.account), ...(result.updatedUser ? { user: publicUser(mapUser(result.updatedUser, accountId)) } : {}) }; }
  async endpoint(accountId: string) { const account = await this.account(accountId); return { ...endpoint(account), account_status: account.status }; }
  async quotaSummary(accountId: string) { return this.quota.getAccountQuota(accountId); }
  async usage(accountId: string, query: Record<string, unknown>) { const result = await this.audit(accountId, query); return { items: result.rows.map(usageItem), pagination: { page: result.page, page_size: result.pageSize, total: result.total } }; }
  async history(accountId: string, query: Record<string, unknown>) { const result = await this.audit(accountId, query); return { items: result.rows.map(historyItem), pagination: { page: result.page, page_size: result.pageSize, total: result.total } }; }
  async securityEvents(userId: string, limit: number) { const rows = await this.transactions.runAsOperator((tx) => tx.securityEvent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(limit, 1), 100), select: { id: true, eventType: true, createdAt: true } })); return rows.map((row) => ({ id: row.id, event_type: row.eventType, created_at: row.createdAt.toISOString() })); }

  async exportAccount(user: User, reauthentication: SensitiveAction, metadata: RequestMetadata) {
    await this.verifySensitiveAction(user, reauthentication);
    const accountId = await this.requireAccountId(user);
    const account = await this.account(accountId);
    const [tokens, credentials, quota, history] = await Promise.all([this.tokens.list(accountId), this.credentials.list(accountId), this.quota.getAccountQuota(accountId), this.exportAudit(accountId)]);
    await this.transactions.runAsOperator((tx) => tx.securityEvent.create({ data: { id: crypto.randomUUID(), userId: user.id, eventType: "account_exported", ipLabel: privacyLabel(metadata.clientIp), userAgentLabel: privacyLabel(metadata.userAgent) } }));
    return { exported_at: new Date().toISOString(), user: publicUser(user), account: publicAccount(account), endpoint: endpoint(account), quota, tokens, credentials, request_history: history.rows.map(historyItem), request_history_truncated: history.truncated, request_history_limit: 1000 };
  }

  async requestDeletion(user: User, reauthentication: SensitiveAction, metadata: RequestMetadata) {
    await this.verifySensitiveAction(user, reauthentication);
    const accountId = await this.requireAccountId(user);
    const workflowId = crypto.randomUUID();
    const userName = escapeHtml(user.name);
    const userEmail = escapeHtml(user.email);
    const retention = "Your request and confirmation email have been queued for operator review. We will confirm which records are retained for security, billing, or legal obligations.";
    await this.transactions.runAsOperator(async (tx) => {
      await tx.securityEvent.create({ data: { id: crypto.randomUUID(), userId: user.id, eventType: "account_deletion_requested", ipLabel: privacyLabel(metadata.clientIp), userAgentLabel: privacyLabel(metadata.userAgent), metadata: { workflow_id: workflowId, account_id: accountId } } });
      const messages = [{ recipient: user.email, kind: "account_deletion_confirmation", idempotencyKey: `account-deletion-confirmation:${workflowId}`, subject: "Your Firecrawl Gateway deletion request was received", html: `<p>Hello ${userName},</p><p>Your account deletion request was received and queued for operator review.</p><p>Reference: ${workflowId}</p><p>${retention}</p>` }];
      if (this.config.adminEmail) messages.push({ recipient: this.config.adminEmail, kind: "account_deletion_operator_notification", idempotencyKey: `account-deletion-operator:${workflowId}`, subject: "Account deletion request requires operator review", html: `<p>A deletion request requires operator review.</p><p>User: ${userName} (${userEmail})</p><p>Account: ${escapeHtml(accountId)}</p><p>Reference: ${workflowId}</p>` });
      await tx.emailOutbox.createMany({ data: messages.map((message) => ({ id: crypto.randomUUID(), idempotencyKey: message.idempotencyKey, userId: user.id, kind: message.kind, recipient: message.recipient, payloadEncrypted: encryptAuthValue(JSON.stringify({ subject: message.subject, html: message.html }), this.config.authEncryptionKey) })), skipDuplicates: true });
    });
    return { status: "queued", workflow_id: workflowId, retention };
  }

  private async verifySensitiveAction(user: User, input: SensitiveAction) { if (!(await this.auth.verifyPassword(input.current_password, user.password_hash))) throw new UnauthorizedException("Current password is incorrect"); const mfa = await this.auth.getMfaState(user.id); if (!mfa.enabled) return; const valid = input.recovery_code ? await this.auth.consumeRecoveryCode(user.id, input.recovery_code) : await this.auth.verifyMfaCode(user.id, input.mfa_code ?? ""); if (!valid) throw new UnauthorizedException("MFA is required"); }
  private async exportAudit(accountId: string) { const rows: AuditRow[] = []; let page = 1; while (rows.length < 1000) { const result = await this.audit(accountId, { page, page_size: 100 }); rows.push(...result.rows); if (result.rows.length < 100 || rows.length >= result.total) return { rows, truncated: false }; page += 1; } const latest = await this.audit(accountId, { page: 11, page_size: 1 }); return { rows, truncated: latest.total > rows.length }; }
  private async requireAccountId(user: User) { if (!user.account_id) throw new NotFoundException("Account unavailable"); return user.account_id; }
  private async account(accountId: string | null | undefined) { if (!accountId) throw new NotFoundException("Account unavailable"); const row = await this.transactions.runForAccount(accountId, (tx) => tx.account.findUnique({ where: { id: accountId }, select: { id: true, publicId: true, displayName: true, status: true, fundingPreference: true, createdAt: true, updatedAt: true } })); if (!row) throw new NotFoundException("Account unavailable"); return row; }
  private async audit(accountId: string, query: Record<string, unknown>) { const page = pageNumber(query.page); const pageSize = pageSizeValue(query.page_size); const where: Prisma.AuditLogWhereInput = { accountId }; const period = typeof query.period === "string" ? query.period : undefined; if (period === "7d" || period === "week") where.createdAt = { gte: new Date(Date.now() - 7 * 86400000) }; else if (period === "30d" || period === "month") where.createdAt = { gte: new Date(Date.now() - 30 * 86400000) }; if (query.status === "2xx") where.statusCode = { gte: 200, lt: 300 }; if (query.status === "4xx") where.statusCode = { gte: 400, lt: 500 }; if (query.status === "5xx") where.statusCode = { gte: 500, lt: 600 }; const [rows, total] = await this.transactions.runForAccount(accountId, async (tx) => Promise.all([tx.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, select: auditSelect }), tx.auditLog.count({ where })])); return { rows, total, page, pageSize }; }
}

function mapUser(row: { id: string; email: string; normalizedEmail: string; name: string; passwordHash: string; isAdmin: boolean; platformRole: string; emailVerifiedAt: Date | null; authVersion: number; status: string; suspendedUntil: Date | null; createdAt: Date; updatedAt: Date }, accountId: string): User { return { id: row.id, email: row.email, normalized_email: row.normalizedEmail, name: row.name, password_hash: row.passwordHash, is_admin: row.isAdmin, platform_role: row.platformRole, email_verified_at: row.emailVerifiedAt?.toISOString() ?? null, auth_version: row.authVersion, account_id: accountId, status: row.status, suspended_until: row.suspendedUntil?.toISOString() ?? null, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() }; }
function publicUser(user: User) { const { password_hash: _password, account_id: _account, ...safe } = user; return safe; }
function publicAccount(row: { publicId: string; displayName: string; status: string; fundingPreference: string; createdAt: Date; updatedAt: Date }) { return { public_id: row.publicId, display_name: row.displayName, status: row.status, funding_preference: row.fundingPreference, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() }; }
function endpoint(row: { publicId: string; status: string }) { return { endpoint_id: row.publicId, base_path: `/e/${encodeURIComponent(row.publicId)}`, immutable: true, status: row.status === "active" ? "active" : "unavailable" }; }
function pageNumber(value: unknown) { const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1; }
function pageSizeValue(value: unknown) { const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : 25; }
function routeFamily(path: string) { const match = path.match(/^\/(v[12])\/([^/?]+)/i); return match ? `/${match[1].toLowerCase()}/${match[2]}` : "/unknown"; }
function fundingType(value: string | null) { return value === "included" || value === "byok" ? value : "unknown"; }
function statusBucket(status: number) { return status >= 200 && status < 400 ? "2xx" : status >= 400 && status < 500 ? "4xx" : status >= 500 ? "5xx" : "other"; }
function usageItem(row: AuditRow) { return { id: row.id, timestamp: row.createdAt.toISOString(), route_family: routeFamily(row.path), funding_type: fundingType(row.fundingType), status: row.statusCode, status_bucket: statusBucket(row.statusCode), duration_ms: row.durationMs, request_id: row.requestId }; }
function historyItem(row: AuditRow) { return { id: row.id, method: row.method, route_family: routeFamily(row.path), timestamp: row.createdAt.toISOString(), source_class: row.backendUsed === "self-hosted" ? "self-hosted" : row.backendUsed === "cloud" ? "cloud" : "gateway", funding_type: fundingType(row.fundingType), status: row.statusCode, duration_ms: row.durationMs, request_id: row.requestId, target: "redacted" }; }
function summary(rows: AuditRow[]) { const successful = rows.filter((row) => row.statusCode >= 200 && row.statusCode < 400).length; const errors = rows.filter((row) => row.statusCode >= 400).length; return { requests: rows.length, successful, errors, average_latency_ms: rows.length ? Math.round(rows.reduce((total, row) => total + row.durationMs, 0) / rows.length) : 0, included_requests: rows.filter((row) => row.fundingType === "included").length, byok_requests: rows.filter((row) => row.fundingType === "byok").length }; }
function escapeHtml(value: string) { return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" })[character] ?? character); }
