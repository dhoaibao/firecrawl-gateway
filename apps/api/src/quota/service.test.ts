import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type {
  AccountEntitlementRecord,
  FreeTierEnrollmentRecord,
  FreeTierPolicyRecord,
  QuotaEventRecord,
  QuotaPeriodRecord,
  UsageEventRecord,
  UsageReservationRecord,
} from "./types";

const holder = vi.hoisted(() => {
  /** In-memory mirror of the quota tables and their guarded SQL semantics. */
  interface FakeState {
    policy: FreeTierPolicyRecord;
    enrollments: Map<string, FreeTierEnrollmentRecord>;
    periods: Map<string, QuotaPeriodRecord>;
    entitlements: Map<string, AccountEntitlementRecord>;
    reservations: Map<string, UsageReservationRecord>;
    events: UsageEventRecord[];
    quotaEvents: Array<{ dedupKey: string; payload: Record<string, unknown> }>;
    users: Map<string, { status: string; email_verified_at: string | null }>;
    accounts: Map<string, { status: string }>;
  }

  function nowIso(): string {
    return new Date().toISOString();
  }


function makePolicy(overrides: Partial<FreeTierPolicyRecord> = {}): FreeTierPolicyRecord {
  return {
    id: "default",
    default_grant: 100,
    commitment_ceiling: 1000,
    hard_monthly_cap: 5000,
    committed_amount: 0,
    admissions_enabled: true,
    included_traffic_enabled: true,
    warning_thresholds: {},
    next_period_changes: [],
    version: 1,
    updated_by: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...overrides,
  };
}

function entitlementKey(accountId: string, periodId: string): string {
  return `${accountId}:${periodId}`;
}

class FakeRepo {
  constructor(public state: FakeState) {}

  async getPolicy(_client: PoolClient): Promise<FreeTierPolicyRecord | null> {
    return { ...this.state.policy };
  }

  async lockPolicy(_client: PoolClient): Promise<FreeTierPolicyRecord | null> {
    return { ...this.state.policy };
  }

  async incrementCommitment(_client: PoolClient, grant: number): Promise<boolean> {
    const policy = this.state.policy;
    if (!policy.admissions_enabled) return false;
    if (policy.committed_amount + grant > policy.commitment_ceiling) return false;
    policy.committed_amount += grant;
    policy.version += 1;
    return true;
  }

  async decrementCommitment(_client: PoolClient, grant: number): Promise<boolean> {
    if (this.state.policy.committed_amount < grant) return false;
    this.state.policy.committed_amount = Math.max(this.state.policy.committed_amount - grant, 0);
    this.state.policy.version += 1;
    return true;
  }

  async getEnrollment(_client: PoolClient, accountId: string): Promise<FreeTierEnrollmentRecord | null> {
    const row = this.state.enrollments.get(accountId);
    return row ? { ...row } : null;
  }

  async lockEnrollment(_client: PoolClient, accountId: string): Promise<FreeTierEnrollmentRecord | null> {
    return this.getEnrollment(_client, accountId);
  }

  async insertEnrollment(
    _client: PoolClient,
    accountId: string,
    status: FreeTierEnrollmentRecord["status"],
    grant: number,
    actor: string | null,
    reason: string | null,
  ): Promise<FreeTierEnrollmentRecord> {
    const existing = this.state.enrollments.get(accountId);
    if (existing) return { ...existing };
    const row: FreeTierEnrollmentRecord = {
      account_id: accountId,
      status,
      grant_amount: grant,
      admitted_at: status === "enrolled" ? nowIso() : null,
      waitlisted_at: status === "waitlisted" ? nowIso() : null,
      revoked_at: null,
      operator_reason: reason,
      operator_actor: actor,
      skipped_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.state.enrollments.set(accountId, row);
    return { ...row };
  }

  async updateEnrollmentStatus(
    _client: PoolClient,
    accountId: string,
    status: FreeTierEnrollmentRecord["status"],
    actor: string,
    reason: string,
  ): Promise<FreeTierEnrollmentRecord | null> {
    const row = this.state.enrollments.get(accountId);
    if (!row) return null;
    if (status === "enrolled") row.admitted_at = row.admitted_at ?? nowIso();
    if (status === "waitlisted") row.waitlisted_at = row.waitlisted_at ?? nowIso();
    if (status === "revoked") row.revoked_at = nowIso();
    row.status = status;
    row.operator_reason = reason;
    row.operator_actor = actor;
    row.skipped_at = null;
    row.updated_at = nowIso();
    return { ...row };
  }

  async markWaitlistSkipped(_client: PoolClient, accountId: string, actor: string, reason: string): Promise<FreeTierEnrollmentRecord | null> {
    const row = this.state.enrollments.get(accountId);
    if (!row || row.status !== "waitlisted") return null;
    row.operator_reason = reason;
    row.operator_actor = actor;
    row.skipped_at = nowIso();
    row.updated_at = nowIso();
    return { ...row };
  }

  async getPeriod(_client: PoolClient, periodId: string): Promise<QuotaPeriodRecord | null> {
    const row = this.state.periods.get(periodId);
    return row ? { ...row } : null;
  }

  async lockOpenPeriod(_client: PoolClient): Promise<QuotaPeriodRecord | null> {
    const row = [...this.state.periods.values()].find((period) => period.status === "open");
    return row ? { ...row } : null;
  }

  async upsertPeriod(_client: PoolClient, periodId: string, start: Date, end: Date, hardCap: number): Promise<QuotaPeriodRecord> {
    const existing = this.state.periods.get(periodId);
    if (existing) return { ...existing };
    const row: QuotaPeriodRecord = {
      id: periodId,
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      hard_cap: hardCap,
      reserved: 0,
      consumed: 0,
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.state.periods.set(periodId, row);
    return { ...row };
  }

  async getEntitlement(_client: PoolClient, accountId: string, periodId: string): Promise<AccountEntitlementRecord | null> {
    const row = this.state.entitlements.get(entitlementKey(accountId, periodId));
    return row ? { ...row } : null;
  }

  async insertEntitlement(
    _client: PoolClient,
    accountId: string,
    periodId: string,
    allocated: number,
    snapshot: Record<string, unknown>,
  ): Promise<AccountEntitlementRecord> {
    const key = entitlementKey(accountId, periodId);
    const existing = this.state.entitlements.get(key);
    if (existing) return { ...existing };
    const row: AccountEntitlementRecord = {
      id: `ent-${accountId}-${periodId}`,
      account_id: accountId,
      period_id: periodId,
      allocated,
      reserved: 0,
      consumed: 0,
      status: "active",
      enrollment_snapshot: snapshot,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.state.entitlements.set(key, row);
    return { ...row };
  }

  async issueEntitlementsForPeriod(_client: PoolClient, periodId: string): Promise<number> {
    let issued = 0;
    for (const [accountId, enrollment] of this.state.enrollments) {
      if (enrollment.status !== "enrolled") continue;
      const user = this.state.users.get(accountId);
      const account = this.state.accounts.get(accountId);
      if (!user?.email_verified_at || user.status !== "active" || account?.status !== "active") continue;
      const key = entitlementKey(accountId, periodId);
      if (this.state.entitlements.has(key)) continue;
      this.state.entitlements.set(key, {
        id: `ent-${accountId}-${periodId}`,
        account_id: accountId,
        period_id: periodId,
        allocated: enrollment.grant_amount,
        reserved: 0,
        consumed: 0,
        status: "active",
        enrollment_snapshot: { enrollment_status: "enrolled", grant_amount: enrollment.grant_amount, initial_allocated: enrollment.grant_amount },
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      issued += 1;
    }
    return issued;
  }

  async setEntitlementStatusForAccount(_client: PoolClient, accountId: string, status: AccountEntitlementRecord["status"], periodId?: string): Promise<number> {
    let updated = 0;
    for (const entitlement of this.state.entitlements.values()) {
      if (entitlement.account_id !== accountId) continue;
      if (periodId && entitlement.period_id !== periodId) continue;
      if (entitlement.status !== "active" && entitlement.status !== "suspended") continue;
      entitlement.status = status;
      entitlement.updated_at = nowIso();
      updated += 1;
    }
    return updated;
  }

  async reserveAccountSlot(_client: PoolClient, accountId: string, periodId: string): Promise<AccountEntitlementRecord | null> {
    const entitlement = this.state.entitlements.get(entitlementKey(accountId, periodId));
    if (!entitlement || entitlement.status !== "active") return null;
    if (entitlement.consumed + entitlement.reserved >= entitlement.allocated) return null;
    entitlement.reserved += 1;
    return { ...entitlement };
  }

  async reservePeriodSlot(_client: PoolClient, periodId: string): Promise<QuotaPeriodRecord | null> {
    const period = this.state.periods.get(periodId);
    if (!period || period.status !== "open") return null;
    if (period.consumed + period.reserved >= period.hard_cap) return null;
    period.reserved += 1;
    return { ...period };
  }

  async getReservation(_client: PoolClient, id: string): Promise<UsageReservationRecord | null> {
    const row = this.state.reservations.get(id);
    return row ? { ...row } : null;
  }

  async lockReservation(_client: PoolClient, id: string): Promise<UsageReservationRecord | null> {
    // The runner serializes transactions, so locking is equivalent to a read.
    const row = this.state.reservations.get(id);
    return row ? { ...row } : null;
  }

  async insertReservation(_client: PoolClient, input: { id: string; accountId: string; periodId: string; entitlementId: string; expiresAt: Date }): Promise<UsageReservationRecord | null> {
    if (this.state.reservations.has(input.id)) return null;
    const row: UsageReservationRecord = {
      id: input.id,
      account_id: input.accountId,
      period_id: input.periodId,
      entitlement_id: input.entitlementId,
      status: "reserved",
      expires_at: input.expiresAt.toISOString(),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.state.reservations.set(input.id, row);
    return { ...row };
  }

  async rearmReservation(_client: PoolClient, id: string, expiresAt: Date): Promise<UsageReservationRecord | null> {
    const row = this.state.reservations.get(id);
    if (!row || row.status !== "released") return null;
    row.status = "reserved";
    row.expires_at = expiresAt.toISOString();
    row.updated_at = nowIso();
    return { ...row };
  }

  async finalizeReservation(_client: PoolClient, requestId: string, reason: string): Promise<UsageReservationRecord | null> {
    const reservation = this.state.reservations.get(requestId);
    if (!reservation || reservation.status !== "reserved") return null;
    if (this.state.events.some((event) => event.request_id === requestId)) return null;
    reservation.status = "consumed";
    reservation.updated_at = nowIso();
    const entitlement = this.state.entitlements.get(entitlementKey(reservation.account_id, reservation.period_id));
    if (entitlement) {
      entitlement.consumed += 1;
      entitlement.reserved = Math.max(entitlement.reserved - 1, 0);
    }
    const period = this.state.periods.get(reservation.period_id);
    if (period) {
      period.consumed += 1;
      period.reserved = Math.max(period.reserved - 1, 0);
    }
    this.state.events.push({
      id: `ev-${requestId}`,
      request_id: requestId,
      account_id: reservation.account_id,
      period_id: reservation.period_id,
      kind: "charge",
      amount: 1,
      actor: null,
      reason,
      created_at: nowIso(),
    });
    return { ...reservation };
  }

  async releaseReservation(_client: PoolClient, requestId: string): Promise<UsageReservationRecord | null> {
    const reservation = this.state.reservations.get(requestId);
    if (!reservation || reservation.status !== "reserved") return null;
    reservation.status = "released";
    reservation.updated_at = nowIso();
    const entitlement = this.state.entitlements.get(entitlementKey(reservation.account_id, reservation.period_id));
    if (entitlement) entitlement.reserved = Math.max(entitlement.reserved - 1, 0);
    const period = this.state.periods.get(reservation.period_id);
    if (period) period.reserved = Math.max(period.reserved - 1, 0);
    return { ...reservation };
  }

  async listExpiredReservations(_client: PoolClient, limit: number): Promise<UsageReservationRecord[]> {
    return [...this.state.reservations.values()]
      .filter((row) => row.status === "reserved" && row.expires_at < nowIso())
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async insertAdjustmentEvent(_client: PoolClient, input: { requestId: string; accountId: string; periodId: string | null; amount: number; actor: string; reason: string }): Promise<UsageEventRecord> {
    if (this.state.events.some((event) => event.request_id === input.requestId)) {
      throw new Error(`Adjustment event ${input.requestId} already exists`);
    }
    const event: UsageEventRecord = {
      id: `ev-${input.requestId}`,
      request_id: input.requestId,
      account_id: input.accountId,
      period_id: input.periodId,
      kind: "adjustment",
      amount: input.amount,
      actor: input.actor,
      reason: input.reason,
      created_at: nowIso(),
    };
    this.state.events.push(event);
    return event;
  }

  async claimWaitlistCandidates(_client: PoolClient, batch: number): Promise<Array<FreeTierEnrollmentRecord & { account_status: string; email_verified_at: string | null }>> {
    return [...this.state.enrollments.values()]
      .filter((row) => {
        if (row.status !== "waitlisted" || row.skipped_at) return false;
        const user = this.state.users.get(row.account_id);
        const account = this.state.accounts.get(row.account_id);
        return Boolean(user?.email_verified_at && user.status === "active" && account?.status === "active");
      })
      .sort((a, b) => (a.waitlisted_at ?? "").localeCompare(b.waitlisted_at ?? "") || a.account_id.localeCompare(b.account_id))
      .slice(0, batch)
      .map((row) => ({
        ...row,
        account_status: this.state.accounts.get(row.account_id)?.status ?? "active",
        email_verified_at: this.state.users.get(row.account_id)?.email_verified_at ?? null,
      }));
  }

  async countWaitlist(_client: PoolClient): Promise<number> {
    return [...this.state.enrollments.values()].filter((row) => row.status === "waitlisted" && !row.skipped_at).length;
  }

  async insertQuotaEvent(
    _client: PoolClient,
    input: { dedupKey: string; eventType: string; severity: "info" | "warn" | "critical"; accountId?: string; periodId?: string; payload?: Record<string, unknown> },
  ): Promise<QuotaEventRecord | null> {
    if (this.state.quotaEvents.some((event) => event.dedupKey === input.dedupKey)) return null;
    this.state.quotaEvents.push({ dedupKey: input.dedupKey, payload: input.payload ?? {} });
    return {
      id: `quota-${input.dedupKey}`,
      dedup_key: input.dedupKey,
      event_type: input.eventType,
      severity: input.severity,
      account_id: input.accountId ?? null,
      period_id: input.periodId ?? null,
      payload: input.payload ?? {},
      created_at: nowIso(),
    };
  }
}

  /** Lazy delegating repository facade; the store is swapped per test. */
  const REPO_EXPORTS = [
    "getPolicy", "lockPolicy", "incrementCommitment", "decrementCommitment",
    "getEnrollment", "lockEnrollment", "insertEnrollment", "updateEnrollmentStatus",
    "markWaitlistSkipped", "getPeriod", "upsertPeriod", "setPeriodStatus",
    "getEntitlement", "insertEntitlement", "setEntitlementStatusForAccount",
    "issueEntitlementsForPeriod", "reserveAccountSlot", "reservePeriodSlot",
    "insertReservation", "getReservation", "lockReservation", "rearmReservation",
    "finalizeReservation", "releaseReservation", "listExpiredReservations",
    "insertAdjustmentEvent", "claimWaitlistCandidates", "countWaitlist",
    "insertQuotaEvent", "lockOpenPeriod",
  ] as const;

  function buildRepo(): Record<string, (...args: unknown[]) => unknown> {
    const facade: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of REPO_EXPORTS) {
      facade[name] = (...args: unknown[]) =>
        (holder.store as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args);
    }
    return facade;
  }

  /** Mirrors client-side SQL the service issues directly. */
  function fakeClient(): PoolClient {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      const store = holder.store;
      if (sql.includes("FROM accounts a") && sql.includes("account_memberships m")) {
        const accountId = String(params[0]);
        const user = store.state.users.get(accountId);
        const account = store.state.accounts.get(accountId);
        return {
          rows: [{ email_verified_at: user?.email_verified_at ?? null, user_status: user?.status ?? "active", account_status: account?.status ?? "active" }],
        };
      }
      if (sql.includes("status = 'closed'")) {
        const cutoff = String(params[0]);
        for (const period of store.state.periods.values()) {
          if (period.status === "open" && period.period_end <= cutoff) {
            period.status = "closed";
          }
        }
        return { rows: [] };
      }
      if (sql.includes("SELECT account_id, grant_amount FROM free_tier_enrollments")) {
        const newGrant = Number(params[0]);
        return {
          rows: [...store.state.enrollments.values()]
            .filter((row) => row.status === "enrolled" && row.grant_amount !== newGrant)
            .map((row) => ({ account_id: row.account_id, grant_amount: row.grant_amount })),
        };
      }
      if (sql.includes("SET default_grant = $1, commitment_ceiling = $2, hard_monthly_cap = $3")) {
        store.state.policy.default_grant = Number(params[0]);
        store.state.policy.commitment_ceiling = Number(params[1]);
        store.state.policy.hard_monthly_cap = Number(params[2]);
        return { rows: [] };
      }
      if (sql.includes("SET next_period_changes = $1::jsonb")) {
        store.state.policy.next_period_changes = JSON.parse(String(params[0])) as Array<Record<string, unknown>>;
        return { rows: [] };
      }
      if (sql.includes("SET committed_amount = committed_amount + $1")) {
        store.state.policy.committed_amount += Number(params[0]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE free_tier_enrollments SET grant_amount = $2")) {
        const enrollment = store.state.enrollments.get(String(params[0]));
        if (enrollment) enrollment.grant_amount = Number(params[1]);
        return { rows: [] };
      }
      if (sql.includes("SELECT consumed, reserved FROM quota_periods")) {
        const period = [...store.state.periods.values()].find((p) => p.status === "open");
        return { rows: period ? [{ consumed: String(period.consumed), reserved: String(period.reserved) }] : [] };
      }
      if (sql.includes("SET hard_cap")) {
        const bySecondParam = sql.includes("WHERE id = $2");
        const id = String(params[bySecondParam ? 1 : 0]);
        const period = store.state.periods.get(id) ?? [...store.state.periods.values()].find((p) => p.status === "open");
        if (period) period.hard_cap = Number(params[bySecondParam ? 0 : 1]);
        return { rows: [] };
      }
      if (sql.includes("SET allocated =")) {
        const entitlement = store.state.entitlements.get(entitlementKey(String(params[0]), String(params[1])));
        if (!entitlement) return { rows: [] };
        entitlement.allocated = Number(params[2]);
        entitlement.updated_at = new Date().toISOString();
        return { rows: [{ ...entitlement }] };
      }
      // Reconciliation queries (read-only).
      if (sql.includes("FROM free_tier_enrollments WHERE status = 'enrolled'")) {
        const sum = [...store.state.enrollments.values()]
          .filter((row) => row.status === "enrolled")
          .reduce((total, row) => total + row.grant_amount, 0);
        return { rows: [{ expected: String(sum) }] };
      }
      if (sql.includes("FROM usage_events WHERE kind = 'charge'")) {
        const periodId = String(params[0]);
        const byAccount = new Map<string, number>();
        for (const event of store.state.events) {
          if (event.kind === "charge" && event.period_id === periodId) {
            byAccount.set(event.account_id, (byAccount.get(event.account_id) ?? 0) + event.amount);
          }
        }
        return { rows: [...byAccount.entries()].map(([account_id, charged]) => ({ account_id, charged: String(charged) })) };
      }
      if (sql.includes("FROM usage_events WHERE kind = 'adjustment'")) {
        const accountId = String(params[0]);
        const periodId = String(params[1]);
        const sum = store.state.events
          .filter((event) => event.kind === "adjustment" && event.account_id === accountId && event.period_id === periodId)
          .reduce((total, event) => total + event.amount, 0);
        return { rows: [{ adjusted: String(sum) }] };
      }
      if (sql.includes("FROM account_entitlements WHERE period_id")) {
        const periodId = String(params[0]);
        return { rows: [...store.state.entitlements.values()].filter((row) => row.period_id === periodId).map((row) => ({ ...row })) };
      }
      if (sql.includes("FROM usage_reservations WHERE status = 'reserved'")) {
        const byEntitlement = new Map<string, number>();
        for (const reservation of store.state.reservations.values()) {
          if (reservation.status === "reserved") {
            byEntitlement.set(reservation.entitlement_id, (byEntitlement.get(reservation.entitlement_id) ?? 0) + 1);
          }
        }
        return { rows: [...byEntitlement.entries()].map(([entitlement_id, reserved]) => ({ entitlement_id, reserved: String(reserved) })) };
      }
      if (sql.includes("COALESCE(SUM(consumed), 0) AS consumed")) {
        const periodId = String(params[0]);
        const rows = [...store.state.entitlements.values()].filter((row) => row.period_id === periodId);
        return {
          rows: [{
            consumed: String(rows.reduce((total, row) => total + row.consumed, 0)),
            reserved: String(rows.reduce((total, row) => total + row.reserved, 0)),
          }],
        };
      }
      return { rows: [] };
    });
    return { query } as unknown as PoolClient;
  }

  /** A global mutex so concurrent service calls behave like serialized row locks. */
  let transactionQueue: Promise<unknown> = Promise.resolve();
  function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = transactionQueue.then(fn);
    transactionQueue = result.catch(() => undefined);
    return result;
  }

  /** Snapshot/restore mirrors BEGIN/ROLLBACK for the fake transactions. */
  function cloneState(): string {
    return JSON.stringify({
      policy: holder.store.state.policy,
      enrollments: [...holder.store.state.enrollments.entries()],
      periods: [...holder.store.state.periods.entries()],
      entitlements: [...holder.store.state.entitlements.entries()],
      reservations: [...holder.store.state.reservations.entries()],
      events: holder.store.state.events,
      quotaEvents: holder.store.state.quotaEvents,
      users: [...holder.store.state.users.entries()],
      accounts: [...holder.store.state.accounts.entries()],
    });
  }

  function restoreState(snapshot: string): void {
    const parsed = JSON.parse(snapshot) as ReturnType<typeof holder.cloneState> extends string
      ? {
          policy: FreeTierPolicyRecord;
          enrollments: Array<[string, FreeTierEnrollmentRecord]>;
          periods: Array<[string, QuotaPeriodRecord]>;
          entitlements: Array<[string, AccountEntitlementRecord]>;
          reservations: Array<[string, UsageReservationRecord]>;
          events: UsageEventRecord[];
          quotaEvents: Array<{ dedupKey: string; payload: Record<string, unknown> }>;
          users: Array<[string, { status: string; email_verified_at: string | null }]>;
          accounts: Array<[string, { status: string }]>;
        }
      : never;
    const state = holder.store.state;
    state.policy = parsed.policy;
    state.enrollments = new Map(parsed.enrollments);
    state.periods = new Map(parsed.periods);
    state.entitlements = new Map(parsed.entitlements);
    state.reservations = new Map(parsed.reservations);
    state.events = parsed.events;
    state.quotaEvents = parsed.quotaEvents;
    state.users = new Map(parsed.users);
    state.accounts = new Map(parsed.accounts);
  }

  function freshState(): FakeState {
    return {
      policy: makePolicy(),
      enrollments: new Map(),
      periods: new Map(),
      entitlements: new Map(),
      reservations: new Map(),
      events: [],
      quotaEvents: [],
      users: new Map(),
      accounts: new Map(),
    };
  }

  function seedAccount(state: FakeState, accountId: string): void {
    state.users.set(accountId, { status: "active", email_verified_at: "2026-01-01T00:00:00.000Z" });
    state.accounts.set(accountId, { status: "active" });
  }

  return {
    FakeRepo,
    buildRepo,
    fakeClient,
    runSerialized,
    cloneState,
    restoreState,
    freshState,
    seedAccount,
    store: null as unknown as InstanceType<typeof FakeRepo>,
  };
});

let state: ReturnType<typeof holder.freshState> = holder.freshState();

/** Top-level aliases for the test bodies; the implementations live in the hoisted holder. */
const seedAccount = (state: Parameters<typeof holder.seedAccount>[0], accountId: string): void =>
  holder.seedAccount(state, accountId);
const nowIso = (): string => new Date().toISOString();

vi.mock("../db", () => ({
  withOperatorTransaction: vi.fn(async (fn: (client: PoolClient) => Promise<unknown>) => {
    const snapshot = holder.cloneState();
    try {
      return await holder.runSerialized(() => fn(holder.fakeClient()));
    } catch (error) {
      holder.restoreState(snapshot);
      throw error;
    }
  }),
}));

vi.mock("./repository", () => holder.buildRepo());

import * as quotaService from "./service";

describe("quota service state machine", () => {
  beforeEach(() => {
    state = holder.freshState();
    holder.store = new holder.FakeRepo(state);
    vi.clearAllMocks();
  });

  it("admits accounts under the ceiling and issues a current entitlement", async () => {
    seedAccount(state, "account-a");
    const outcome = await quotaService.admitAccount("account-a", "verification");
    expect(outcome.status).toBe("enrolled");
    expect(state.policy.committed_amount).toBe(100);
    expect(state.policy.commitment_ceiling).toBeGreaterThanOrEqual(state.policy.committed_amount);
    expect(outcome.status === "enrolled" ? outcome.entitlement?.allocated : undefined).toBe(100);
  });

  it("evaluates commitment thresholds using the post-admission counter", async () => {
    state.policy.warning_thresholds = { commitment_pct: [10] };
    seedAccount(state, "account-a");

    await quotaService.admitAccount("account-a");

    const threshold = state.quotaEvents.find((event) => event.dedupKey === "commitment_threshold:10:v2");
    expect(threshold?.payload).toMatchObject({ committed: 100, ceiling: 1000, pct: 10 });
  });

  it("waitlists accounts that cannot fit under the ceiling without touching commitment", async () => {
    state.policy.committed_amount = 950;
    state.policy.commitment_ceiling = 1000;
    seedAccount(state, "account-b");
    const outcome = await quotaService.admitAccount("account-b");
    expect(outcome.status).toBe("waitlisted");
    expect(state.policy.committed_amount).toBe(950);
    expect(state.enrollments.get("account-b")?.status).toBe("waitlisted");
  });

  it("never pushes commitments above the ceiling under concurrent admission", async () => {
    state.policy.commitment_ceiling = 1000;
    const accounts = Array.from({ length: 20 }, (_, index) => `account-${index}`);
    for (const account of accounts) seedAccount(state, account);

    const outcomes = await Promise.all(accounts.map((account) => quotaService.admitAccount(account)));
    const enrolled = outcomes.filter((outcome) => outcome.status === "enrolled").length;
    const waitlisted = outcomes.filter((outcome) => outcome.status === "waitlisted").length;

    expect(enrolled).toBe(10);
    expect(waitlisted).toBe(10);
    expect(state.policy.committed_amount).toBe(10 * 100);
    expect(state.policy.committed_amount).toBeLessThanOrEqual(state.policy.commitment_ceiling);
  });

  it("returns the existing result on admission retry without changing counters", async () => {
    seedAccount(state, "account-a");
    const first = await quotaService.admitAccount("account-a");
    expect(first.status).toBe("enrolled");
    const committedAfterFirst = state.policy.committed_amount;

    const retry = await quotaService.admitAccount("account-a", "verification-retry");
    expect(retry.status).toBe("enrolled");
    expect(state.policy.committed_amount).toBe(committedAfterFirst);
    expect(state.enrollments.size).toBe(1);
  });

  it("suspension blocks spending but keeps the slot; reactivation resumes the remainder", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    const reserved = await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    expect("reserved" in reserved && reserved.reserved).toBe(true);
    await quotaService.finalizeReservation("account-a:request-1:2026-01");

    await quotaService.suspendAccountEntitlements("account-a");
    const blocked = await quotaService.reserveIncluded("account-a", "request-2", new Date("2026-01-16T00:00:00.000Z"));
    expect(blocked).toMatchObject({ code: "quota_paused" });
    expect(state.policy.committed_amount).toBe(100);

    await quotaService.resumeAccountEntitlements("account-a");
    const resumed = await quotaService.reserveIncluded("account-a", "request-3", new Date("2026-01-17T00:00:00.000Z"));
    expect("reserved" in resumed && resumed.reserved).toBe(true);
  });

  it("revocation releases the committed slot exactly once and blocks included use", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));

    await quotaService.revokeFreeTier("account-a", "operator@example", "abuse");
    expect(state.policy.committed_amount).toBe(0);
    expect(state.enrollments.get("account-a")?.status).toBe("revoked");
    const entitlement = state.entitlements.get("account-a:2026-01");
    expect(entitlement?.status).toBe("revoked");

    const blocked = await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    expect(blocked).toMatchObject({ code: "quota_paused" });

    const again = await quotaService.revokeFreeTier("account-a", "operator@example", "again");
    expect(again?.status).toBe("revoked");
    expect(state.policy.committed_amount).toBe(0);
  });

  it("issues exactly one entitlement per eligible account even when called twice", async () => {
    seedAccount(state, "account-a");
    seedAccount(state, "account-b");
    await quotaService.admitAccount("account-a");
    await quotaService.admitAccount("account-b");
    state.users.set("account-c", { status: "active", email_verified_at: "2026-01-01T00:00:00.000Z" });
    state.accounts.set("account-c", { status: "blocked" });
    state.enrollments.set("account-c", {
      account_id: "account-c", status: "enrolled", grant_amount: 100,
      admitted_at: nowIso(), waitlisted_at: null, revoked_at: null,
      operator_reason: null, operator_actor: null, skipped_at: null, created_at: nowIso(), updated_at: nowIso(),
    });

    const first = await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    expect(first.issued).toBe(2);
    const second = await quotaService.openNextPeriod(new Date("2026-01-16T00:00:00.000Z"));
    expect(second.issued).toBe(0);
    const january = [...state.entitlements.values()].filter((entry) => entry.period_id === "2026-01");
    expect(january.length).toBe(2);
    expect(state.entitlements.has("account-c:2026-01")).toBe(false);
  });

  it("expired unused allowance cannot be spent in a later period", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    await quotaService.releaseReservation("account-a:request-1:2026-01");

    await quotaService.openNextPeriod(new Date("2026-02-01T00:00:00.000Z"));
    expect(state.periods.get("2026-01")?.status).toBe("closed");
    const next = await quotaService.reserveIncluded("account-a", "request-2", new Date("2026-02-01T00:00:00.000Z"));
    expect("reserved" in next && next.reserved).toBe(true);
    expect("periodId" in next ? next.periodId : "").toBe("2026-02");
    expect(state.entitlements.get("account-a:2026-01")?.consumed).toBe(0);
  });

  it("reserves once and charges exactly once per request id across retries", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));

    const first = await quotaService.reserveIncluded("account-a", "request-x", new Date("2026-01-15T00:00:00.000Z"));
    expect("reserved" in first && first.reserved).toBe(true);
    const entitlement = state.entitlements.get("account-a:2026-01");
    expect(entitlement?.reserved).toBe(1);

    // A crash-retried dispatch with the same id must not double-reserve.
    const retry = await quotaService.reserveIncluded("account-a", "request-x", new Date("2026-01-15T00:01:00.000Z"));
    expect("reserved" in retry && retry.reserved).toBe(true);
    expect(state.entitlements.get("account-a:2026-01")?.reserved).toBe(1);

    expect(await quotaService.finalizeReservation("account-a:request-x:2026-01")).toBe(true);
    expect(await quotaService.finalizeReservation("account-a:request-x:2026-01")).toBe(false);
    expect(entitlement?.consumed).toBe(1);
    expect(entitlement?.reserved).toBe(0);
    expect(state.events.filter((event) => event.kind === "charge").length).toBe(1);

    // Replaying a consumed id returns the original charge metadata without
    // creating a new reservation or charging a second time.
    const replay = await quotaService.reserveIncluded("account-a", "request-x", new Date("2026-01-16T00:00:00.000Z"));
    expect("reserved" in replay && replay.reserved).toBe(true);
    expect("reservationId" in replay ? replay.reservationId : "").toBe("account-a:request-x:2026-01");
    expect(state.events.filter((event) => event.kind === "charge").length).toBe(1);
  });

  it("rejects when the account allowance is exhausted and releases pre-dispatch reservations", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    const entitlement = state.entitlements.get("account-a:2026-01");
    entitlement!.consumed = 100;
    entitlement!.allocated = 100;

    const outcome = await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    expect(outcome).toMatchObject({ code: "quota_exhausted", statusCode: 429 });
    expect(state.entitlements.get("account-a:2026-01")?.reserved).toBe(0);

    state.entitlements.get("account-a:2026-01")!.consumed = 0;
    const reserved = await quotaService.reserveIncluded("account-a", "request-2", new Date("2026-01-15T00:00:00.000Z"));
    expect("reserved" in reserved).toBe(true);
    await quotaService.releaseReservation("account-a:request-2:2026-01");
    expect(state.entitlements.get("account-a:2026-01")?.reserved).toBe(0);
    expect(state.reservations.get("account-a:request-2:2026-01")?.status).toBe("released");
  });

  it("rejects when the platform hard cap is reached without bumping the account counter", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    const period = state.periods.get("2026-01")!;
    period.hard_cap = 1;
    period.consumed = 1;

    const outcome = await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    expect(outcome).toMatchObject({ code: "quota_hard_cap", statusCode: 429 });
    expect(state.entitlements.get("account-a:2026-01")?.reserved).toBe(0);
  });

  it("rejects waitlisted accounts with no entitlement and paused traffic", async () => {
    seedAccount(state, "account-a");
    state.policy.included_traffic_enabled = false;
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    const paused = await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    expect(paused).toMatchObject({ code: "quota_paused" });

    state.policy.included_traffic_enabled = true;
    const waitlisted = await quotaService.reserveIncluded("account-a", "request-2", new Date("2026-01-15T00:00:00.000Z"));
    expect(waitlisted).toMatchObject({ code: "no_entitlement", statusCode: 403 });
  });

  it("reconciles expired in-flight reservations conservatively and never double-charges", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    // Expire it by backdating.
    state.reservations.get("account-a:request-1:2026-01")!.expires_at = "2026-01-01T00:00:00.000Z";

    expect(await quotaService.reconcileExpiredReservations()).toBe(1);
    expect(state.entitlements.get("account-a:2026-01")?.consumed).toBe(1);
    expect(state.entitlements.get("account-a:2026-01")?.reserved).toBe(0);
    expect(await quotaService.reconcileExpiredReservations()).toBe(0);
  });

  it("processes the waitlist FIFO and stops when the next grant cannot fit", async () => {
    state.policy.commitment_ceiling = 250;
    for (const account of ["account-a", "account-b", "account-c"]) seedAccount(state, account);
    for (const account of ["account-a", "account-b", "account-c"]) {
      await quotaService.admitAccount(account);
    }
    // account-a, account-b admitted (200 committed); account-c waitlisted? No:
    // the ceiling is 250 so only account-a (100) fits; the rest waitlist.
    const enrolled = [...state.enrollments.values()].filter((row) => row.status === "enrolled");
    expect(enrolled.length).toBe(2);
    expect(state.policy.committed_amount).toBe(200);

    state.policy.commitment_ceiling = 300;
    const result = await quotaService.processWaitlist(10);
    expect(result.admitted).toBe(1);
    expect(state.enrollments.get("account-c")?.status).toBe("enrolled");
    expect(state.policy.committed_amount).toBe(300);
  });

  it("skipped waitlist rows are not claimed automatically", async () => {
    state.policy.commitment_ceiling = 1000;
    seedAccount(state, "account-a");
    seedAccount(state, "account-b");
    await quotaService.admitAccount("account-a");
    await quotaService.admitAccount("account-b");

    // Push the ceiling back down so neither was admitted... instead use a fresh
    // state where both waitlisted.
    state.policy.committed_amount = 1000;
    seedAccount(state, "account-c");
    await quotaService.admitAccount("account-c");
    expect(state.enrollments.get("account-c")?.status).toBe("waitlisted");

    await quotaService.skipWaitlist("account-c", "operator", "manual review needed");
    state.policy.commitment_ceiling = 1200;
    const result = await quotaService.processWaitlist(10);
    expect(result.admitted).toBe(0);
    expect(state.enrollments.get("account-c")?.status).toBe("waitlisted");
  });

  it("rejects policy updates that lower the ceiling below committed amounts", async () => {
    state.policy.committed_amount = 400;
    await expect(
      quotaService.updatePolicy({ commitmentCeiling: 300, actor: "operator@example" }),
    ).rejects.toThrow(/cannot be lowered below the committed amount/);
    await expect(
      quotaService.updatePolicy({ defaultGrant: 0, actor: "operator@example" }),
    ).rejects.toThrow(/positive integer/);
  });

  it("rejects a hard cap below usage already committed on the open period", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    const reserved = await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    expect("reserved" in reserved && reserved.reserved).toBe(true);

    await expect(
      quotaService.updatePolicy({ hardMonthlyCap: 0, actor: "operator@example" }),
    ).rejects.toThrow(/cannot be lowered below the current open-period usage/);
    // A cap equal to the in-use amount is allowed and applied.
    await quotaService.updatePolicy({ hardMonthlyCap: 1, actor: "operator@example" });
    expect([...state.periods.values()].find((p) => p.status === "open")?.hard_cap).toBe(1);
  });

  it("manual waitlist promotion claims a committed slot under the ceiling", async () => {
    state.policy.commitment_ceiling = 500;
    for (const id of ["account-a", "account-b", "account-c", "account-d", "account-e"]) {
      seedAccount(state, id);
      expect((await quotaService.admitAccount(id)).status).toBe("enrolled");
    }
    seedAccount(state, "account-f");
    await quotaService.admitAccount("account-f");
    expect(state.enrollments.get("account-f")?.status).toBe("waitlisted");
    expect(state.policy.committed_amount).toBe(500);

    // Revoking an enrolled account frees a slot; promotion claims it.
    await quotaService.revokeFreeTier("account-d", "operator@example", "abuse");
    expect(state.policy.committed_amount).toBe(400);
    const promoted = await quotaService.manualAdmit("account-f", "operator@example", "promotion", new Date("2026-01-15T00:00:00.000Z"));
    expect(promoted.status).toBe("enrolled");
    expect(state.policy.committed_amount).toBe(500);

    // Without headroom the same promotion is refused; counters stay put.
    seedAccount(state, "account-g");
    await quotaService.admitAccount("account-g");
    expect(state.enrollments.get("account-g")?.status).toBe("waitlisted");
    const blocked = await quotaService.manualAdmit("account-g", "operator@example", "promotion", new Date("2026-01-15T00:00:00.000Z"));
    expect(blocked.status).toBe("waitlisted");
    expect(state.policy.committed_amount).toBe(500);
  });

  it("never reuses another account's reservation for a replayed request id", async () => {
    seedAccount(state, "account-a");
    seedAccount(state, "account-b");
    await quotaService.admitAccount("account-a");
    await quotaService.admitAccount("account-b");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));

    const first = await quotaService.reserveIncluded("account-a", "shared-id", new Date("2026-01-15T00:00:00.000Z"));
    expect("reserved" in first && first.reserved).toBe(true);
    expect("reservationId" in first ? first.reservationId : "").toBe("account-a:shared-id:2026-01");

    // account-b replays account-a's request id: it must get its own fresh
    // reservation, never account-a's row, and never account-a's quota.
    const second = await quotaService.reserveIncluded("account-b", "shared-id", new Date("2026-01-15T00:01:00.000Z"));
    expect("reserved" in second && second.reserved).toBe(true);
    const secondId = "reservationId" in second ? second.reservationId : "";
    expect(secondId).toBe("account-b:shared-id:2026-01");
    expect(secondId).not.toBe("account-a:shared-id:2026-01");
    expect(state.entitlements.get("account-a:2026-01")?.reserved).toBe(1);
    expect(state.entitlements.get("account-b:2026-01")?.reserved).toBe(1);

    // Finalizing account-b's fresh reservation charges account-b only.
    expect(await quotaService.finalizeReservation(secondId)).toBe(true);
    expect(state.entitlements.get("account-b:2026-01")?.consumed).toBe(1);
    expect(state.entitlements.get("account-a:2026-01")?.consumed).toBe(0);
    expect(state.events.filter((event) => event.kind === "charge").length).toBe(1);
    // account-a's row is still reserved and finalizes for account-a.
    expect(await quotaService.finalizeReservation("account-a:shared-id:2026-01")).toBe(true);
    expect(state.entitlements.get("account-a:2026-01")?.consumed).toBe(1);

    // account-b's next retry finds its OWN namespaced row; it never creates a
    // second fresh reservation that would double-charge.
    const replay = await quotaService.reserveIncluded("account-b", "shared-id", new Date("2026-01-15T00:02:00.000Z"));
    expect("reservationId" in replay ? replay.reservationId : "").toBe("account-b:shared-id:2026-01");
    expect(state.entitlements.get("account-b:2026-01")?.consumed).toBe(1);
    expect(state.entitlements.get("account-b:2026-01")?.reserved).toBe(0);
  });

  it("a same-account retry in a later month starts a fresh reservation for that period", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));

    const january = await quotaService.reserveIncluded("account-a", "retry-x", new Date("2026-01-15T00:00:00.000Z"));
    expect("reserved" in january && january.reserved).toBe(true);
    expect("reservationId" in january ? january.reservationId : "").toBe("account-a:retry-x:2026-01");
    expect(await quotaService.finalizeReservation("account-a:retry-x:2026-01")).toBe(true);
    expect(state.entitlements.get("account-a:2026-01")?.consumed).toBe(1);

    // Same client request id, next month: the old consumed row is historical;
    // the retry must reserve (and later charge) the NEW period instead.
    await quotaService.openNextPeriod(new Date("2026-02-01T00:00:00.000Z"));
    const february = await quotaService.reserveIncluded("account-a", "retry-x", new Date("2026-02-01T00:00:00.000Z"));
    expect("reserved" in february && february.reserved).toBe(true);
    expect("reservationId" in february ? february.reservationId : "").toBe("account-a:retry-x:2026-02");
    expect("periodId" in february ? february.periodId : "").toBe("2026-02");
    expect(state.entitlements.get("account-a:2026-02")?.reserved).toBe(1);
    expect(state.entitlements.get("account-a:2026-01")?.consumed).toBe(1);

    // A repeat of the new-period reservation is an idempotent replay.
    const replay = await quotaService.reserveIncluded("account-a", "retry-x", new Date("2026-02-01T00:01:00.000Z"));
    expect("reservationId" in replay ? replay.reservationId : "").toBe("account-a:retry-x:2026-02");
    expect(state.entitlements.get("account-a:2026-02")?.reserved).toBe(1);
  });

  it("applies scheduled ceiling before grant changes on lazy period recovery", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    state.policy.warning_thresholds = { commitment_pct: [10] };
    state.policy.next_period_changes = [{
      period_id: "2026-02",
      default_grant: 200,
      commitment_ceiling: 2000,
      hard_monthly_cap: 9000,
    }];

    const reserved = await quotaService.reserveIncluded("account-a", "scheduled-request", new Date("2026-02-01T00:00:00.000Z"));
    expect("reserved" in reserved && reserved.reserved).toBe(true);
    expect(state.policy.commitment_ceiling).toBe(2000);
    expect(state.policy.hard_monthly_cap).toBe(9000);
    expect(state.enrollments.get("account-a")?.grant_amount).toBe(200);
    expect(state.policy.next_period_changes).toEqual([]);
    expect(state.entitlements.get("account-a:2026-02")?.allocated).toBe(200);
    expect(state.periods.get("2026-02")?.hard_cap).toBe(9000);
    expect(state.quotaEvents.some((event) => event.payload.committed === 200)).toBe(true);
  });

  it("refuses admission to accounts without a verified email or active status", async () => {
    seedAccount(state, "account-a");
    state.users.get("account-a")!.email_verified_at = null;
    await expect(quotaService.admitAccount("account-a")).rejects.toThrow(/not eligible/);
    expect(state.policy.committed_amount).toBe(0);
    expect(state.enrollments.has("account-a")).toBe(false);

    seedAccount(state, "account-b");
    state.users.get("account-b")!.status = "suspended";
    await expect(quotaService.admitAccount("account-b")).rejects.toThrow(/not eligible/);
    expect(state.policy.committed_amount).toBe(0);
    expect(state.enrollments.has("account-b")).toBe(false);

    seedAccount(state, "account-c");
    state.accounts.get("account-c")!.status = "blocked";
    await expect(quotaService.admitAccount("account-c")).rejects.toThrow(/not eligible/);
    expect(state.policy.committed_amount).toBe(0);
    expect(state.enrollments.has("account-c")).toBe(false);
  });

  it("manual admission never commits capacity to an ineligible account", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.revokeFreeTier("account-a", "operator@example", "test");
    state.users.get("account-a")!.email_verified_at = null;

    await expect(
      quotaService.manualAdmit("account-a", "operator@example", "re-entry", new Date("2026-01-15T00:00:00.000Z")),
    ).rejects.toThrow(/not eligible/);
    expect(state.policy.committed_amount).toBe(0);
    expect(state.enrollments.get("account-a")?.status).toBe("revoked");

    // Fresh manual admission of an unverified account: no row, no commitment.
    seedAccount(state, "account-b");
    state.users.get("account-b")!.email_verified_at = null;
    await expect(
      quotaService.manualAdmit("account-b", "operator@example", "try", new Date("2026-01-15T00:00:00.000Z")),
    ).rejects.toThrow(/not eligible/);
    expect(state.policy.committed_amount).toBe(0);
    expect(state.enrollments.has("account-b")).toBe(false);
  });

  it("records the acting operator on every enrollment control", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    expect(state.enrollments.get("account-a")?.operator_actor).toBe("verification");

    await quotaService.revokeFreeTier("account-a", "operator-1", "abuse");
    expect(state.enrollments.get("account-a")?.operator_actor).toBe("operator-1");
    expect(state.enrollments.get("account-a")?.operator_reason).toBe("abuse");

    const reAdmitted = await quotaService.manualAdmit("account-a", "operator-2", "re-entry", new Date("2026-01-15T00:00:00.000Z"));
    expect(reAdmitted.status).toBe("enrolled");
    expect(state.enrollments.get("account-a")?.operator_actor).toBe("operator-2");

    // Waitlist skip records the actor too.
    state.policy.commitment_ceiling = 100;
    state.policy.committed_amount = 100;
    seedAccount(state, "account-b");
    await quotaService.admitAccount("account-b");
    expect(state.enrollments.get("account-b")?.status).toBe("waitlisted");
    await quotaService.skipWaitlist("account-b", "operator-3", "manual review");
    expect(state.enrollments.get("account-b")?.operator_actor).toBe("operator-3");
    expect(state.enrollments.get("account-b")?.operator_reason).toBe("manual review");
  });

  it("adjusts individual allowances through the ledger within policy bounds", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));

    const increased = await quotaService.adjustAllowance("account-a", 50, "operator", "promotion", new Date("2026-01-15T00:00:00.000Z"));
    expect(increased.allocated).toBe(150);
    const entitlement = state.entitlements.get("account-a:2026-01")!;
    entitlement.consumed = 120;

    await expect(
      quotaService.adjustAllowance("account-a", -80, "operator", "below usage", new Date("2026-01-15T00:00:00.000Z")),
    ).rejects.toThrow(/below used allowance/);
    const reduced = await quotaService.adjustAllowance("account-a", -30, "operator", "demotion", new Date("2026-01-15T00:00:00.000Z"));
    expect(reduced.allocated).toBe(120);
    expect(state.events.filter((event) => event.kind === "adjustment").length).toBe(2);
  });

  it("reports ledger-versus-counter mismatches read-only", async () => {
    seedAccount(state, "account-a");
    await quotaService.admitAccount("account-a");
    await quotaService.openNextPeriod(new Date("2026-01-15T00:00:00.000Z"));
    await quotaService.reserveIncluded("account-a", "request-1", new Date("2026-01-15T00:00:00.000Z"));
    await quotaService.finalizeReservation("account-a:request-1:2026-01");

    const clean = await quotaService.reconcile("2026-01");
    expect(clean.mismatches).toBe(0);

    // Corrupt the denormalized consumed counter and verify the report catches it.
    state.entitlements.get("account-a:2026-01")!.consumed = 7;
    const dirty = await quotaService.reconcile("2026-01");
    expect(dirty.mismatches).toBeGreaterThan(0);
    expect(dirty.checks.some((check) => check.name === "entitlement_counters_match_ledger" && check.status === "mismatch")).toBe(true);
    // Never repairs.
    expect(state.entitlements.get("account-a:2026-01")!.consumed).toBe(7);
  });
});
