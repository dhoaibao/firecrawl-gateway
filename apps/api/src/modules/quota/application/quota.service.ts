import crypto from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TransactionService } from "../../../core/database/transaction.service";

export type QuotaRejection = { code: string; message: string; statusCode: number };
export interface QuotaReservation { reservationId: string; reserved: boolean; limit: number; remaining: number; resetAt: string; periodId: string; entitlementId: string; }

@Injectable()
export class QuotaService {
  constructor(private readonly transactions: TransactionService) {}

  async getPolicy() {
    return this.transactions.runAsOperator((transaction) => transaction.freeTierPolicy.findUnique({ where: { id: "default" } }));
  }

  async getPolicySummary() {
    const policy = await this.getPolicy();
    if (!policy) return null;
    return serializePolicy(policy);
  }

  async getAccountQuota(accountId: string, now = new Date()) {
    return this.transactions.runAsOperator(async (transaction) => {
      const periodId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const period = await transaction.quotaPeriod.findUnique({ where: { id: periodId } });
      const enrollment = await transaction.freeTierEnrollment.findUnique({ where: { accountId } });
      const entitlement = period ? await transaction.accountEntitlement.findUnique({ where: { accountId_periodId: { accountId, periodId } } }) : null;
      const allocated = entitlement?.allocated ?? 0;
      const consumed = entitlement?.consumed ?? 0;
      const reserved = entitlement?.reserved ?? 0;
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const policy = await transaction.freeTierPolicy.findUnique({ where: { id: "default" }, select: { includedTrafficEnabled: true } });
      return { period_id: periodId, reset_at: end.toISOString(), enrollment_status: enrollment?.status ?? "pending", entitlement_status: entitlement?.status ?? null, allocated, consumed, reserved, remaining: Math.max(allocated - consumed - reserved, 0), included_traffic_available: policy?.includedTrafficEnabled === true && entitlement?.status === "active" && allocated - consumed - reserved > 0 };
    });
  }

  async listWaitlist(limit = 100) {
    const rows = await this.transactions.runAsOperator((transaction) => transaction.freeTierEnrollment.findMany({
      where: { status: "waitlisted" },
      orderBy: { createdAt: "asc" },
      take: Math.min(Math.max(limit, 1), 500),
    }));
    return rows.map((row) => ({
      account_id: row.accountId,
      status: row.status,
      grant_amount: row.grantAmount,
      position: 0,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }));
  }

  async listEntitlements(limit = 100) {
    const rows = await this.transactions.runAsOperator((transaction) => transaction.accountEntitlement.findMany({
      orderBy: { updatedAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
    }));
    return rows.map((row) => ({
      id: row.id,
      account_id: row.accountId,
      period_id: row.periodId,
      allocated: row.allocated,
      reserved: row.reserved,
      consumed: row.consumed,
      remaining: row.allocated - row.reserved - row.consumed,
      status: row.status,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }));
  }

  async listEvents(limit = 100) {
    const rows = await this.transactions.runAsOperator((transaction) => transaction.quotaEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
    }));
    return rows.map((row) => ({
      id: row.id,
      dedup_key: row.dedupKey,
      event_type: row.eventType,
      severity: row.severity,
      account_id: row.accountId,
      period_id: row.periodId,
      payload: row.payload,
      created_at: row.createdAt.toISOString(),
    }));
  }

  async updatePolicy(input: {
    defaultGrant?: number;
    commitmentCeiling?: number;
    hardMonthlyCap?: number;
    admissionsEnabled?: boolean;
    includedTrafficEnabled?: boolean;
    warningThresholds?: unknown;
    actor: string;
    reason: string;
  }) {
    return this.transactions.runAsOperator(async (transaction) => {
      const before = await transaction.freeTierPolicy.findUnique({ where: { id: "default" } });
      if (!before) throw new Error("Free tier policy is not configured");
      const after = await transaction.freeTierPolicy.update({
        where: { id: "default" },
        data: {
          ...(input.defaultGrant === undefined ? {} : { defaultGrant: input.defaultGrant }),
          ...(input.commitmentCeiling === undefined ? {} : { commitmentCeiling: input.commitmentCeiling }),
          ...(input.hardMonthlyCap === undefined ? {} : { hardMonthlyCap: BigInt(input.hardMonthlyCap) }),
          ...(input.admissionsEnabled === undefined ? {} : { admissionsEnabled: input.admissionsEnabled }),
          ...(input.includedTrafficEnabled === undefined ? {} : { includedTrafficEnabled: input.includedTrafficEnabled }),
          ...(input.warningThresholds === undefined ? {} : { warningThresholds: input.warningThresholds as Prisma.InputJsonValue }),
          updatedBy: input.actor,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      await transaction.quotaEvent.create({
        data: {
          id: crypto.randomUUID(),
          dedupKey: `policy:${after.version}:${input.actor}`,
          eventType: "policy_changed",
          severity: "info",
          payload: { reason: input.reason, before: serializePolicy(before), after: serializePolicy(after) },
        },
      });
      return { before: serializePolicy(before), after: serializePolicy(after) };
    });
  }

  async admitAccount(accountId: string, actor: string, reason: string) {
    return this.transactions.runAsOperator(async (transaction) => {
      const policy = await transaction.freeTierPolicy.findUnique({ where: { id: "default" } });
      if (!policy) throw new Error("Free tier policy is not configured");
      if (!policy.admissionsEnabled) throw new QuotaRejectionError({ code: "admissions_disabled", message: "Free tier admissions are disabled", statusCode: 409 });
      const enrollment = await transaction.freeTierEnrollment.upsert({
        where: { accountId },
        create: { accountId, status: "enrolled", grantAmount: policy.defaultGrant, admittedAt: new Date(), operatorActor: actor, operatorReason: reason },
        update: { status: "enrolled", admittedAt: new Date(), revokedAt: null, operatorActor: actor, operatorReason: reason, updatedAt: new Date() },
      });
      return serializeEnrollment(enrollment);
    });
  }

  async skipAccount(accountId: string, actor: string, reason: string) {
    return this.transactions.runAsOperator(async (transaction) => {
      const enrollment = await transaction.freeTierEnrollment.findFirst({ where: { accountId, status: "waitlisted" } });
      if (!enrollment) return null;
      const updated = await transaction.freeTierEnrollment.update({
        where: { accountId },
        data: { status: "skipped", skippedAt: new Date(), operatorActor: actor, operatorReason: reason, updatedAt: new Date() },
      });
      return serializeEnrollment(updated);
    });
  }

  async revokeAccount(accountId: string, actor: string, reason: string) {
    return this.transactions.runAsOperator(async (transaction) => {
      const enrollment = await transaction.freeTierEnrollment.findUnique({ where: { accountId } });
      if (!enrollment) return null;
      const updated = await transaction.freeTierEnrollment.update({
        where: { accountId },
        data: { status: "revoked", revokedAt: new Date(), operatorActor: actor, operatorReason: reason, updatedAt: new Date() },
      });
      await transaction.accountEntitlement.updateMany({ where: { accountId }, data: { status: "revoked", updatedAt: new Date() } });
      return serializeEnrollment(updated);
    });
  }

  async adjustAllowance(accountId: string, amount: number, actor: string, reason: string) {
    if (!Number.isInteger(amount) || amount === 0) throw new Error("amount must be a non-zero integer");
    return this.transactions.runAsOperator(async (transaction) => {
      const period = await currentPeriod(transaction);
      if (!period) throw new Error("Current quota period is not open");
      const entitlement = await transaction.accountEntitlement.findUnique({ where: { accountId_periodId: { accountId, periodId: period.id } } });
      if (!entitlement) throw new Error("Account has no entitlement for the current period");
      const updated = await transaction.accountEntitlement.update({ where: { id: entitlement.id }, data: { allocated: { increment: amount }, updatedAt: new Date() } });
      await transaction.quotaEvent.create({
        data: { id: crypto.randomUUID(), dedupKey: `adjust:${updated.id}:${updated.updatedAt.toISOString()}`, eventType: "allowance_adjusted", severity: "info", accountId, periodId: period.id, payload: { amount, actor, reason } },
      });
      return { ...serializeEntitlement(updated), adjustment: amount };
    });
  }

  async reserveIncluded(accountId: string, requestId: string, now = new Date()): Promise<QuotaReservation | QuotaRejection> {
    try {
      return await this.transactions.runAsOperator(async (transaction) => {
        const policy = await transaction.freeTierPolicy.findUnique({ where: { id: "default" } });
        if (!policy) throw new QuotaRejectionError({ code: "quota_paused", message: "Included quota policy is not configured", statusCode: 503 });
        if (!policy.includedTrafficEnabled) throw new QuotaRejectionError({ code: "quota_paused", message: "Included infrastructure traffic is paused by an operator", statusCode: 503 });
        const periodId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
        const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
        const period = await transaction.quotaPeriod.upsert({ where: { id: periodId }, create: { id: periodId, periodStart, periodEnd, hardCap: policy.hardMonthlyCap }, update: {} });
        if (period.status !== "open") throw new QuotaRejectionError({ code: "quota_paused", message: "The current quota period is not open", statusCode: 503 });
        let entitlement = await transaction.accountEntitlement.findUnique({ where: { accountId_periodId: { accountId, periodId } } });
        if (!entitlement) {
          const enrollment = await transaction.freeTierEnrollment.findUnique({ where: { accountId } });
          if (!enrollment || enrollment.status !== "enrolled") throw new QuotaRejectionError({ code: "no_entitlement", message: "No included entitlement for this account this month", statusCode: 403 });
          entitlement = await transaction.accountEntitlement.create({ data: { id: crypto.randomUUID(), accountId, periodId, allocated: enrollment.grantAmount || policy.defaultGrant, status: "active", enrollmentSnapshot: { status: enrollment.status, grant_amount: enrollment.grantAmount } } });
        }
        const reservationId = `${accountId}:${requestId}:${periodId}`;
        let reservation = await transaction.usageReservation.findUnique({ where: { id: reservationId } });
        if (reservation && reservation.status !== "released") return reservationView(reservation.id, entitlement, period);
        if (!reservation) {
          await transaction.usageReservation.createMany({ data: { id: reservationId, accountId, periodId, entitlementId: entitlement.id, expiresAt: new Date(now.getTime() + 120_000) }, skipDuplicates: true });
          reservation = await transaction.usageReservation.findUniqueOrThrow({ where: { id: reservationId } });
        }
        const accountSlot = await transaction.accountEntitlement.updateMany({ where: { id: entitlement.id, status: "active", reserved: { lt: entitlement.allocated - entitlement.consumed } }, data: { reserved: { increment: 1 }, updatedAt: new Date() } });
        if (accountSlot.count === 0) throw new QuotaRejectionError({ code: "quota_exhausted", message: "Included request allowance exhausted for this month", statusCode: 429 });
        const periodSlot = await transaction.quotaPeriod.updateMany({ where: { id: period.id, status: "open", reserved: { lt: period.hardCap - period.consumed } }, data: { reserved: { increment: 1 }, updatedAt: new Date() } });
        if (periodSlot.count === 0) throw new QuotaRejectionError({ code: "quota_hard_cap", message: "Platform hard capacity reached for this month", statusCode: 429 });
        if (reservation.status === "released") reservation = await transaction.usageReservation.update({ where: { id: reservation.id }, data: { status: "reserved", expiresAt: new Date(now.getTime() + 120_000), updatedAt: new Date() } });
        const updated = await transaction.accountEntitlement.findUniqueOrThrow({ where: { id: entitlement.id } });
        return reservationView(reservation.id, updated, period);
      });
    } catch (error) {
      if (error instanceof QuotaRejectionError) return error.rejection;
      throw error;
    }
  }

  async finalizeReservation(reservationId: string, reason = "operator dispatch"): Promise<boolean> {
    return this.transactions.runAsOperator(async (transaction) => {
      const reservation = await transaction.usageReservation.findUnique({ where: { id: reservationId } });
      if (!reservation) return false;
      const changed = await transaction.usageReservation.updateMany({ where: { id: reservationId, status: "reserved" }, data: { status: "consumed", updatedAt: new Date() } });
      if (changed.count === 0) return false;
      await transaction.accountEntitlement.update({ where: { id: reservation.entitlementId }, data: { reserved: { decrement: 1 }, consumed: { increment: 1 }, updatedAt: new Date() } });
      await transaction.quotaPeriod.update({ where: { id: reservation.periodId }, data: { reserved: { decrement: 1 }, consumed: { increment: 1 }, updatedAt: new Date() } });
      await transaction.usageEvent.create({ data: { id: crypto.randomUUID(), requestId: reservationId, accountId: reservation.accountId, periodId: reservation.periodId, kind: "included_request", amount: 1, actor: "gateway", reason } });
      return true;
    });
  }

  async releaseReservation(reservationId: string): Promise<boolean> {
    return this.transactions.runAsOperator(async (transaction) => {
      const reservation = await transaction.usageReservation.findUnique({ where: { id: reservationId } });
      if (!reservation) return false;
      const changed = await transaction.usageReservation.updateMany({ where: { id: reservationId, status: "reserved" }, data: { status: "released", updatedAt: new Date() } });
      if (changed.count === 0) return false;
      await transaction.accountEntitlement.update({ where: { id: reservation.entitlementId }, data: { reserved: { decrement: 1 }, updatedAt: new Date() } });
      await transaction.quotaPeriod.update({ where: { id: reservation.periodId }, data: { reserved: { decrement: 1 }, updatedAt: new Date() } });
      return true;
    });
  }

  async openNextPeriod(now = new Date()): Promise<{ periodId: string; issued: number }> {
    return this.transactions.runAsOperator(async (transaction) => {
      const periodId = periodIdFor(now);
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const policy = await transaction.freeTierPolicy.findUnique({ where: { id: "default" } });
      if (!policy) throw new Error("Free tier policy is not configured");
      await transaction.quotaPeriod.upsert({ where: { id: periodId }, create: { id: periodId, periodStart, periodEnd, hardCap: policy.hardMonthlyCap }, update: {} });
      await transaction.quotaPeriod.updateMany({ where: { status: "open", periodEnd: { lte: now } }, data: { status: "closed", updatedAt: now } });
      const eligible = await transaction.freeTierEnrollment.findMany({
        where: { status: "enrolled", account: { status: "active", memberships: { some: { role: "owner", user: { status: "active", emailVerifiedAt: { not: null } } } } } },
        select: { accountId: true, grantAmount: true, status: true },
      });
      if (eligible.length === 0) return { periodId, issued: 0 };
      const issued = await transaction.accountEntitlement.createMany({
        data: eligible.map((enrollment) => ({ id: crypto.randomUUID(), accountId: enrollment.accountId, periodId, allocated: enrollment.grantAmount || policy.defaultGrant, status: "active", enrollmentSnapshot: { status: enrollment.status, grant_amount: enrollment.grantAmount } })),
        skipDuplicates: true,
      });
      return { periodId, issued: issued.count };
    });
  }

  async processWaitlist(limit = 25, now = new Date()): Promise<{ admitted: number; remaining: number }> {
    return this.transactions.runAsOperator(async (transaction) => {
      const policy = await transaction.freeTierPolicy.findUnique({ where: { id: "default" } });
      if (!policy || !policy.admissionsEnabled) return { admitted: 0, remaining: await transaction.freeTierEnrollment.count({ where: { status: "waitlisted" } }) };
      const periodId = periodIdFor(now);
      await transaction.quotaPeriod.upsert({ where: { id: periodId }, create: { id: periodId, periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)), hardCap: policy.hardMonthlyCap }, update: {} });
      const candidates = await transaction.freeTierEnrollment.findMany({ where: { status: "waitlisted" }, orderBy: { createdAt: "asc" }, take: Math.min(Math.max(limit, 1), 100) });
      let admitted = 0;
      for (const candidate of candidates) {
        const claimed = await transaction.freeTierPolicy.updateMany({ where: { id: "default", committedAmount: { lte: policy.commitmentCeiling - candidate.grantAmount } }, data: { committedAmount: { increment: candidate.grantAmount }, updatedAt: now } });
        if (claimed.count === 0) break;
        const updated = await transaction.freeTierEnrollment.updateMany({ where: { accountId: candidate.accountId, status: "waitlisted" }, data: { status: "enrolled", admittedAt: now, operatorActor: "waitlist-worker", operatorReason: "automatic admit", updatedAt: now } });
        if (updated.count === 0) {
          await transaction.freeTierPolicy.update({ where: { id: "default" }, data: { committedAmount: { decrement: candidate.grantAmount }, updatedAt: now } });
          continue;
        }
        await transaction.accountEntitlement.upsert({ where: { accountId_periodId: { accountId: candidate.accountId, periodId } }, create: { id: crypto.randomUUID(), accountId: candidate.accountId, periodId, allocated: candidate.grantAmount, status: "active", enrollmentSnapshot: { status: "enrolled", grant_amount: candidate.grantAmount } }, update: {} });
        admitted += 1;
      }
      return { admitted, remaining: await transaction.freeTierEnrollment.count({ where: { status: "waitlisted" } }) };
    });
  }

  async reconcileExpiredReservations(limit = 25, now = new Date()): Promise<number> {
    return this.transactions.runAsOperator(async (transaction) => {
      const expired = await transaction.usageReservation.findMany({ where: { status: "reserved", expiresAt: { lt: now } }, orderBy: { expiresAt: "asc" }, take: Math.min(Math.max(limit, 1), 100) });
      let charged = 0;
      for (const reservation of expired) {
        const changed = await transaction.usageReservation.updateMany({ where: { id: reservation.id, status: "reserved" }, data: { status: "consumed", updatedAt: now } });
        if (changed.count === 0) continue;
        await transaction.accountEntitlement.update({ where: { id: reservation.entitlementId }, data: { reserved: { decrement: 1 }, consumed: { increment: 1 }, updatedAt: now } });
        await transaction.quotaPeriod.update({ where: { id: reservation.periodId }, data: { reserved: { decrement: 1 }, consumed: { increment: 1 }, updatedAt: now } });
        await transaction.usageEvent.create({ data: { id: crypto.randomUUID(), requestId: `reconciliation:${reservation.id}`, accountId: reservation.accountId, periodId: reservation.periodId, kind: "included_request", amount: 1, actor: "quota-worker", reason: "expired in-flight reservation" } });
        charged += 1;
      }
      return charged;
    });
  }

  async suspendAccount(accountId: string): Promise<number> {
    const result = await this.transactions.runAsOperator((transaction) => transaction.accountEntitlement.updateMany({ where: { accountId, status: "active" }, data: { status: "suspended", updatedAt: new Date() } }));
    return result.count;
  }

  async resumeAccount(accountId: string): Promise<unknown> {
    return this.transactions.runAsOperator(async (transaction) => {
      const period = await currentPeriod(transaction);
      if (!period) return null;
      const policy = await transaction.freeTierPolicy.findUnique({ where: { id: "default" } });
      if (!policy) throw new Error("Free tier policy is not configured");
      const enrollment = await transaction.freeTierEnrollment.findUnique({ where: { accountId } });
      if (!enrollment || enrollment.status !== "enrolled") return null;
      const entitlement = await transaction.accountEntitlement.upsert({
        where: { accountId_periodId: { accountId, periodId: period.id } },
        create: { id: crypto.randomUUID(), accountId, periodId: period.id, allocated: enrollment.grantAmount || policy.defaultGrant, status: "active" },
        update: { status: "active", updatedAt: new Date() },
      });
      return serializeEntitlement(entitlement);
    });
  }
}

export class QuotaRejectionError extends Error {
  constructor(readonly rejection: QuotaRejection) {
    super(rejection.message);
  }
}

function periodIdFor(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function currentPeriod(transaction: Prisma.TransactionClient) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const id = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return transaction.quotaPeriod.upsert({ where: { id }, create: { id, periodStart: start, periodEnd: end }, update: {} });
}

function reservationView(id: string, entitlement: { id: string; allocated: number; consumed: number; reserved: number }, period: { id: string; periodEnd: Date }): QuotaReservation {
  return { reservationId: id, reserved: true, limit: entitlement.allocated, remaining: entitlement.allocated - entitlement.consumed - entitlement.reserved, resetAt: period.periodEnd.toISOString(), periodId: period.id, entitlementId: entitlement.id };
}

function serializePolicy(policy: { id: string; defaultGrant: number; commitmentCeiling: number; hardMonthlyCap: bigint; committedAmount: number; admissionsEnabled: boolean; includedTrafficEnabled: boolean; warningThresholds: Prisma.JsonValue; version: number; updatedBy: string | null; updatedAt: Date }) {
  return { id: policy.id, default_grant: policy.defaultGrant, commitment_ceiling: policy.commitmentCeiling, hard_monthly_cap: Number(policy.hardMonthlyCap), committed_amount: policy.committedAmount, admissions_enabled: policy.admissionsEnabled, included_traffic_enabled: policy.includedTrafficEnabled, warning_thresholds: policy.warningThresholds, version: policy.version, updated_by: policy.updatedBy, updated_at: policy.updatedAt.toISOString() };
}

function serializeEnrollment(row: { accountId: string; status: string; grantAmount: number; admittedAt: Date | null; waitlistedAt: Date | null; revokedAt: Date | null; operatorReason: string | null; operatorActor: string | null; createdAt: Date; updatedAt: Date }) {
  return { account_id: row.accountId, status: row.status, grant_amount: row.grantAmount, admitted_at: row.admittedAt?.toISOString() ?? null, waitlisted_at: row.waitlistedAt?.toISOString() ?? null, revoked_at: row.revokedAt?.toISOString() ?? null, operator_reason: row.operatorReason, operator_actor: row.operatorActor, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() };
}

function serializeEntitlement(row: { id: string; accountId: string; periodId: string; allocated: number; reserved: number; consumed: number; status: string; createdAt: Date; updatedAt: Date }) {
  return { id: row.id, account_id: row.accountId, period_id: row.periodId, allocated: row.allocated, reserved: row.reserved, consumed: row.consumed, remaining: row.allocated - row.reserved - row.consumed, status: row.status, created_at: row.createdAt.toISOString(), updated_at: row.updatedAt.toISOString() };
}
