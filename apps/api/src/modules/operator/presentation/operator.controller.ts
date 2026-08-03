import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import crypto from "node:crypto";
import { routeModeSchema } from "@firecrawl/contracts";
import { Prisma } from "@prisma/client";
import type { SessionRequest } from "../../auth/domain/auth-session";
import type { User } from "../../../types";
import { AuthService } from "../../auth/application/auth.service";
import { AuthGuard } from "../../auth/presentation/auth.guard";
import { AccountsService } from "../../accounts/application/accounts.service";
import { QuotaService } from "../../quota/application/quota.service";
import { GatewayTokensService } from "../../gateway-tokens/application/gateway-tokens.service";
import { ProviderStoreService } from "../../integrations/application/provider-store.service";
import { TransactionService } from "../../../core/database/transaction.service";
import { OperatorMfaGuard, OperatorStepUpGuard, PlatformAdminGuard } from "./operator.guards";

const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

@Controller("api/v1/admin")
@UseGuards(AuthGuard, PlatformAdminGuard, OperatorMfaGuard)
export class OperatorController {
  constructor(
    private readonly auth: AuthService,
    private readonly accounts: AccountsService,
    private readonly quota: QuotaService,
    private readonly tokens: GatewayTokensService,
    private readonly credentials: ProviderStoreService,
    private readonly transactions: TransactionService,
  ) {}

  @Get()
  status() {
    return { data: { service: "operator-console", read_only: false, utc: new Date().toISOString() } };
  }

  @Post("step-up")
  @HttpCode(200)
  async stepUp(@Req() request: SessionRequest, @Body() body: Record<string, unknown>) {
    const user = request.authUser;
    if (!user || typeof body.current_password !== "string") throw new BadRequestException("current_password is required");
    if (!(await this.auth.verifyPassword(body.current_password, user.password_hash))) throw new BadRequestException({ message: "Step-up verification failed", code: "step_up_failed" });
    const mfa = await this.auth.getMfaState(user.id);
    const code = typeof body.mfa_code === "string" ? body.mfa_code : undefined;
    const recovery = typeof body.recovery_code === "string" ? body.recovery_code : undefined;
    const verified = !mfa.enabled || (recovery ? await this.auth.consumeRecoveryCode(user.id, recovery) : await this.auth.verifyMfaCode(user.id, code ?? ""));
    if (!verified) throw new BadRequestException({ message: "Step-up verification failed", code: "step_up_failed" });
    request.session.operatorStepUpAt = Date.now();
    await request.session.save();
    return { success: true, expires_at: new Date(Date.now() + STEP_UP_WINDOW_MS).toISOString() };
  }

  @Get("accounts")
  async listAccounts(@Query() query: Record<string, string | undefined>) {
    const users = await this.accounts.listUsers();
    const q = query.q?.trim().toLowerCase();
    const filtered = users.filter((user) => (!q || user.email.toLowerCase().includes(q) || user.name.toLowerCase().includes(q)) && (!query.status || user.status === query.status) && (query.verified === undefined || Boolean(user.email_verified_at) === (query.verified === "true")));
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);
    return { data: filtered.slice(0, limit).map(serializeUser), pagination: { total: filtered.length, limit } };
  }

  @Get("accounts/:id")
  async getAccount(@Param("id") id: string) {
    const user = await this.accounts.getUser(id);
    if (!user) throw new NotFoundException("Account not found");
    const accountId = user.account_id ?? `personal:${user.id}`;
    const [tokens, credentials, sessions, quota, mfa] = await Promise.all([this.tokens.list(accountId), this.credentials.list(accountId), this.auth.listSessions(user.id), this.quota.getAccountQuota(accountId), this.auth.getMfaState(user.id)]);
    return { data: { identity: serializeUser(user), account_id: accountId, endpoint_id: accountId, tokens, credentials, sessions, quota, security: { mfa } } };
  }

  @Post("accounts/:id/suspend")
  @UseGuards(OperatorStepUpGuard)
  async suspend(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() request: SessionRequest) {
    this.rejectSelf(request, id, "suspend");
    const duration = Math.min(Math.max(Number(body.duration_ms) || 24 * 60 * 60 * 1000, 60_000), 365 * 24 * 60 * 60 * 1000);
    const user = await this.accounts.updateUser(id, { status: "suspended", suspendedUntil: new Date(Date.now() + duration).toISOString() });
    if (!user) throw new NotFoundException("Account not found");
    return { data: serializeUser(user), reason: body.reason };
  }

  @Post("accounts/:id/block")
  @UseGuards(OperatorStepUpGuard)
  async block(@Param("id") id: string, @Req() request: SessionRequest) {
    this.rejectSelf(request, id, "block");
    const user = await this.accounts.updateUser(id, { status: "blocked", suspendedUntil: null });
    if (!user) throw new NotFoundException("Account not found");
    return { data: serializeUser(user) };
  }

  @Post("accounts/:id/reactivate")
  @UseGuards(OperatorStepUpGuard)
  async reactivate(@Param("id") id: string) {
    const user = await this.accounts.updateUser(id, { status: "active", suspendedUntil: null });
    if (!user) throw new NotFoundException("Account not found");
    return { data: serializeUser(user) };
  }

  @Post("accounts/:id/free-tier/revoke")
  @UseGuards(OperatorStepUpGuard)
  async revokeFreeTier(@Param("id") id: string, @Body("reason") reason?: string, @Req() request?: SessionRequest) {
    const actor = request?.authUser?.email ?? "operator";
    return { data: await this.quota.revokeAccount(`personal:${id}`, actor, reason?.trim() || "operator revocation") };
  }

  @Post("accounts/:id/sessions/revoke-all")
  @UseGuards(OperatorStepUpGuard)
  async revokeSessions(@Param("id") id: string) {
    const user = await this.accounts.getUser(id);
    if (!user) throw new NotFoundException("Account not found");
    await this.auth.revokeAllSessions(id);
    return { success: true };
  }

  @Post("accounts/:id/tokens/revoke-all")
  @UseGuards(OperatorStepUpGuard)
  async revokeTokens(@Param("id") id: string) {
    const user = await this.accounts.getUser(id);
    if (!user) throw new NotFoundException("Account not found");
    const revoked = await this.tokens.revokeAllAny(user.account_id ?? `personal:${id}`);
    return { success: true, revoked };
  }

  @Delete("accounts/:id")
  @UseGuards(OperatorStepUpGuard)
  async deleteAccount(@Param("id") id: string, @Req() request: SessionRequest) {
    this.rejectSelf(request, id, "delete");
    const result = await this.accounts.deleteUser(id);
    if (result === "last_admin") throw new BadRequestException("The last operator cannot be deleted");
    if (result === "not_found") throw new NotFoundException("Account not found");
    return { success: true };
  }

  @Get("usage")
  async usage(@Query("from") from?: string, @Query("to") to?: string, @Query("limit") limit?: string) { return { data: await operatorAnalytics(this.transactions, { from, to, limit: Number(limit) || 20 }) }; }

  @Get("requests")
  async requests(@Query("from") from?: string, @Query("to") to?: string, @Query("limit") limit?: string) { return { data: await operatorAnalytics(this.transactions, { from, to, limit: Number(limit) || 20 }) }; }

  @Get("notifications")
  async notifications(@Query("state") state?: string, @Query("limit") rawLimit?: string) {
    const allowed = ["active", "acknowledged", "resolved"];
    const rows = await this.transactions.runAsOperator((tx) => tx.operatorNotification.findMany({ where: allowed.includes(state ?? "") ? { state } : undefined, orderBy: { lastOccurredAt: "desc" }, take: Math.min(Math.max(Number(rawLimit) || 50, 1), 100) }));
    return { data: rows.map(serializeNotification) };
  }

  @Post("notifications/:id/acknowledge")
  @UseGuards(OperatorStepUpGuard)
  async acknowledge(@Param("id") id: string, @Req() request: SessionRequest) { return this.updateNotification(id, "acknowledged", request.authUser?.email ?? "operator"); }

  @Post("notifications/:id/resolve")
  @UseGuards(OperatorStepUpGuard)
  async resolve(@Param("id") id: string, @Req() request: SessionRequest) { return this.updateNotification(id, "resolved", request.authUser?.email ?? "operator"); }

  @Get("configuration")
  async configuration() {
    const rows = await this.transactions.runAsOperator((tx) => tx.setting.findMany({ orderBy: { key: "asc" } }));
    return { data: rows.map((row) => ({ key: row.key, configured: Boolean(row.value), value: ["default_route_mode", "api_key_inactivity_revoke_days"].includes(row.key) ? row.value : undefined })) };
  }

  @Put("configuration")
  @UseGuards(OperatorStepUpGuard)
  async updateConfiguration(@Body() body: Record<string, unknown>) {
    const allowed = new Set(["default_route_mode", "api_key_inactivity_revoke_days"]);
    const updates = Object.entries(body).filter(([key]) => key !== "reason");
    for (const [key, value] of updates) {
      if (!allowed.has(key) || (typeof value !== "string" && typeof value !== "number")) throw new BadRequestException(`Unsupported or invalid configuration key: ${key}`);
      if (key === "default_route_mode" && (typeof value !== "string" || !routeModeSchema.options.includes(value as never))) throw new BadRequestException("default_route_mode is invalid");
      if (key === "api_key_inactivity_revoke_days" && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new BadRequestException("api_key_inactivity_revoke_days must be a non-negative number");
    }
    await this.transactions.runAsOperator(async (tx) => { for (const [key, value] of updates) await tx.setting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value), updatedAt: new Date() } }); });
    return { success: true };
  }

  @Get("security")
  async security(@Query("user_id") userId?: string, @Query("limit") rawLimit?: string) {
    const limit = Math.min(Math.max(Number(rawLimit) || 100, 1), 100);
    const events = await this.transactions.runAsOperator((transaction) => transaction.securityEvent.findMany({ where: userId ? { userId } : undefined, orderBy: { createdAt: "desc" }, take: limit }));
    return { data: events.map((event) => ({ id: event.id, user_id: event.userId, event_type: event.eventType, created_at: event.createdAt.toISOString(), metadata: event.metadata })) };
  }

  @Get("capacity")
  async capacity() { return { data: await this.quota.getPolicySummary() }; }

  private rejectSelf(request: SessionRequest, id: string, action: string): void { if (request.authUser?.id === id) throw new BadRequestException(`Operators cannot ${action} themselves`); }

  private async updateNotification(id: string, state: "acknowledged" | "resolved", actor: string) {
    const data = state === "acknowledged" ? { state, acknowledgedAt: new Date(), acknowledgedBy: actor } : { state, resolvedAt: new Date(), resolvedBy: actor };
    const result = await this.transactions.runAsOperator((tx) => tx.operatorNotification.updateMany({ where: { id }, data }));
    if (!result.count) throw new NotFoundException("Notification not found");
    return { success: true };
  }
}

function serializeUser(user: User) {
  return { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin, platform_role: user.platform_role, email_verified_at: user.email_verified_at, auth_version: user.auth_version, account_id: user.account_id, status: user.status, suspended_until: user.suspended_until, created_at: user.created_at, updated_at: user.updated_at };
}

function serializeNotification(row: { id: string; type: string; severity: string; state: string; firstOccurredAt: Date; lastOccurredAt: Date; acknowledgedAt: Date | null; acknowledgedBy: string | null; resolvedAt: Date | null; resolvedBy: string | null; periodId: string | null; sourceId: string | null; accountId: string | null; payload: unknown; emailStatus: string; emailAttempts: number; lastEmailError: string | null; createdAt: Date; updatedAt: Date }) {
  return { id: row.id, type: row.type, severity: row.severity, state: row.state, first_occurred_at: row.firstOccurredAt.toISOString(), last_occurred_at: row.lastOccurredAt.toISOString(), acknowledged_at: row.acknowledgedAt?.toISOString() ?? null, acknowledged_by: row.acknowledgedBy, resolved_at: row.resolvedAt?.toISOString() ?? null, resolved_by: row.resolvedBy, period_id: row.periodId, source_id: row.sourceId, account_id: row.accountId, payload: row.payload, email_status: row.emailStatus, email_attempts: row.emailAttempts, last_email_error: row.lastEmailError, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() };
}

@Controller("admin/api")
@UseGuards(AuthGuard, PlatformAdminGuard, OperatorMfaGuard)
export class AdminAuditController {
  constructor(private readonly transactions: TransactionService, private readonly accounts: AccountsService) {}

  @Get("logs")
  async logs() { const rows = await this.transactions.runAsOperator((tx) => tx.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 500 })); return { data: rows.map(serializeAudit) }; }

  @Get("data")
  async data() {
    const [rows, users] = await Promise.all([this.transactions.runAsOperator((tx) => tx.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 500 })), this.accounts.listUsers()]);
    const durations = rows.map((row) => row.durationMs).filter(Number.isFinite);
    return { data: rows.map(serializeAudit), totals: { total: rows.length, self_hosted: rows.filter((row) => row.backendUsed === "self-hosted").length, cloud: rows.filter((row) => row.backendUsed === "cloud").length, fallbacks: rows.filter((row) => row.fallbackUsed).length, avgDuration: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0 }, users: users.map(serializeUser) };
  }

  @Delete("logs/:id")
  @UseGuards(OperatorStepUpGuard)
  async deleteLog(@Param("id") id: string, @Body() body: Record<string, unknown>, @Req() request: SessionRequest) {
    const deletion = deletionInput(body); await this.recordDeletion(request, deletion, 1);
    const result = await this.transactions.runAsOperator((tx) => tx.auditLog.deleteMany({ where: { id } }));
    if (!result.count) throw new NotFoundException("Audit entry not found");
    return { success: true };
  }

  @Delete("logs")
  @UseGuards(OperatorStepUpGuard)
  async deleteLogs(@Query("filter") filter: string | undefined, @Body() body: Record<string, unknown>, @Req() request: SessionRequest) {
    const deletion = deletionInput(body);
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string" || !id.trim())) throw new BadRequestException("ids must contain only non-empty strings");
      const ids = [...new Set((body.ids as string[]).map((id) => id.trim()))];
      if (!ids.length) throw new BadRequestException("At least one log id is required");
      await this.recordDeletion(request, deletion, ids.length);
      const result = await this.transactions.runAsOperator((tx) => tx.auditLog.deleteMany({ where: { id: { in: ids } } }));
      return { success: true, deleted: result.count };
    }
    if (!filter || !["today", "week", "month"].includes(filter)) throw new BadRequestException("Invalid filter. Use: today, week, or month");
    const days = filter === "today" ? 1 : filter === "week" ? 7 : 30;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await this.recordDeletion(request, deletion, 1);
    const result = await this.transactions.runAsOperator((tx) => tx.auditLog.deleteMany({ where: { createdAt: { gte: from } } }));
    return { success: true, deleted: result.count };
  }

  private async recordDeletion(request: SessionRequest, deletion: { exception: "legal" | "account-deletion"; reason: string }, count: number) {
    await this.transactions.runAsOperator((tx) => tx.securityEvent.create({ data: { id: crypto.randomUUID(), userId: request.authUser?.id, eventType: "audit_deletion_exception", metadata: { exception: deletion.exception, reason: deletion.reason, count } } }));
  }
}

function deletionInput(body: Record<string, unknown>): { exception: "legal" | "account-deletion"; reason: string } {
  const exception = body.exception;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if ((exception !== "legal" && exception !== "account-deletion") || !reason) throw new BadRequestException("Deletion requires exception (legal or account-deletion) and reason");
  return { exception, reason };
}

function serializeAudit(row: { id: string; createdAt: Date; method: string; path: string; routeMode: string; backendUsed: string; fundingType: string; fallbackUsed: boolean; fallbackReason: string; statusCode: number; durationMs: number; targetUrl: string; userId: string | null; accountId: string | null; requestId: string | null }) {
  return { id: row.id, created_at: row.createdAt.toISOString(), method: row.method, path: row.path, route_mode: row.routeMode, backend_used: row.backendUsed, funding_type: row.fundingType, fallback_used: row.fallbackUsed, fallback_reason: row.fallbackReason, status_code: row.statusCode, duration_ms: row.durationMs, target_url: row.targetUrl, user_id: row.userId, account_id: row.accountId, request_id: row.requestId };
}

async function operatorAnalytics(transactions: TransactionService, options: { from?: string; to?: string; limit: number }) {
  const end = options.to ? new Date(options.to) : new Date();
  const start = options.from ? new Date(options.from) : new Date(end.getTime() - 24 * 60 * 60 * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || end.getTime() - start.getTime() > 31 * 24 * 60 * 60 * 1000) throw new BadRequestException("Analytics range must be valid and no longer than 31 days");
  const limit = Math.min(Math.max(options.limit, 1), 100);
  return transactions.runAsOperator(async (tx) => {
    const [series, dimensions, accounts, email, security] = await Promise.all([
      tx.$queryRaw<Array<{ bucket: Date; requests: bigint; errors: bigint; average_latency_ms: number }>>(Prisma.sql`SELECT date_trunc('hour', created_at) AS bucket, COUNT(*) AS requests, COUNT(*) FILTER (WHERE status_code >= 400) AS errors, COALESCE(AVG(duration_ms), 0) AS average_latency_ms FROM audit_logs WHERE created_at >= ${start} AND created_at < ${end} GROUP BY 1 ORDER BY 1 LIMIT 744`),
      tx.$queryRaw<Array<{ funding_type: string; backend_used: string; route_family: string; status_bucket: string; fallback: bigint; requests: bigint }>>(Prisma.sql`SELECT funding_type, backend_used, split_part(regexp_replace(path, '^/+', ''), '/', 1) AS route_family, CASE WHEN status_code < 300 THEN '2xx' WHEN status_code < 400 THEN '3xx' WHEN status_code < 500 THEN '4xx' ELSE '5xx' END AS status_bucket, COUNT(*) FILTER (WHERE fallback_used) AS fallback, COUNT(*) AS requests FROM audit_logs WHERE created_at >= ${start} AND created_at < ${end} GROUP BY funding_type, backend_used, route_family, status_bucket ORDER BY requests DESC LIMIT 400`),
      tx.$queryRaw<Array<{ user_id: string | null; account_id: string | null; requests: bigint; consumed: bigint }>>(Prisma.sql`SELECT user_id, account_id, COUNT(*) AS requests, COUNT(*) FILTER (WHERE funding_type = 'included') AS consumed FROM audit_logs WHERE created_at >= ${start} AND created_at < ${end} AND account_id IS NOT NULL GROUP BY user_id, account_id ORDER BY requests DESC LIMIT ${limit}`),
      tx.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`SELECT status, COUNT(*) AS count FROM email_outbox WHERE created_at >= ${start} AND created_at < ${end} GROUP BY status ORDER BY count DESC LIMIT 20`),
      tx.$queryRaw<Array<{ event_type: string; count: bigint }>>(Prisma.sql`SELECT event_type, COUNT(*) AS count FROM security_events WHERE created_at >= ${start} AND created_at < ${end} GROUP BY event_type ORDER BY count DESC LIMIT 50`),
    ]);
    const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
    return { range: { from: start.toISOString(), to: end.toISOString() }, series: series.map((row) => ({ bucket: row.bucket.toISOString(), requests: number(row.requests), errors: number(row.errors), average_latency_ms: number(row.average_latency_ms) })), dimensions: dimensions.map((row) => ({ ...row, fallback: number(row.fallback), requests: number(row.requests) })), highest_usage_accounts: accounts.map((row) => ({ ...row, requests: number(row.requests), included_requests: number(row.consumed) })), email_delivery: email.map((row) => ({ status: row.status, count: number(row.count) })), security_events: security.map((row) => ({ event_type: row.event_type, count: number(row.count) })) };
  });
}
