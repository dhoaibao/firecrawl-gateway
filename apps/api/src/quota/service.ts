import crypto from "node:crypto";
import { withOperatorTransaction } from "../db";
import { rootLogger } from "../logger";
import { currentPeriodRange } from "./periods";
import * as repo from "./repository";
import type { DatabaseClient } from "../db";
import type {
  AccountEntitlementRecord,
  AdmissionOutcome,
  FreeTierEnrollmentRecord,
  FreeTierPolicyRecord,
  PeriodChangeInput,
  PolicyUpdateInput,
  QuotaPeriodRecord,
  QuotaRejection,
  QuotaReservation,
  ReconciliationReport,
  WaitlistProcessingResult,
} from "./types";
import { quotaRejection } from "./types";
import { detectCommitmentAndWaitlist, detectConsumption, emitSourcePressure as emitSourcePressureInTransaction } from "./events";

const RESERVATION_TTL_MS = 10 * 60 * 1000;
const WAITLIST_BATCH = 25;

export class QuotaRejectionError extends Error {
  readonly rejection: QuotaRejection;
  constructor(rejection: QuotaRejection) {
    super(rejection.message);
    this.rejection = rejection;
  }
}

/** Operator input errors surface as 400s through the shared error handler. */
export class PolicyValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
  }
}

const logger = rootLogger.child({ module: "quota" });

function throwRejection(code: QuotaRejection["code"], message: string, statusCode: number): never {
  throw new QuotaRejectionError(quotaRejection(code, message, statusCode));
}

function grantForPeriod(policy: FreeTierPolicyRecord, periodId: string): number {
  const scheduled = (policy.next_period_changes ?? []).find((change) => change.period_id === periodId);
  const grant = scheduled?.default_grant ?? policy.default_grant;
  return Number(grant) > 0 ? Number(grant) : policy.default_grant;
}

export async function isAccountEligible(client: DatabaseClient, accountId: string): Promise<boolean> {
  const result = await client.query<{ email_verified_at: string | null; user_status: string; account_status: string }>(
    `SELECT u.email_verified_at, u.status AS user_status, a.status AS account_status
     FROM accounts a
     INNER JOIN account_memberships m ON m.account_id = a.id AND m.role = 'owner'
     INNER JOIN users u ON u.id = m.user_id
     WHERE a.id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  return Boolean(row?.email_verified_at && row.user_status === "active" && row.account_status === "active");
}

/** Idempotent per-account entitlement issuance (lazy recovery path). */
export async function ensureEntitlementFor(
  client: DatabaseClient,
  accountId: string,
  periodId: string,
): Promise<AccountEntitlementRecord | null> {
  const existing = await repo.getEntitlement(client, accountId, periodId);
  if (existing) return existing;

  const enrollment = await repo.getEnrollment(client, accountId);
  if (!enrollment || enrollment.status !== "enrolled") return null;
  if (!(await isAccountEligible(client, accountId))) return null;

  return repo.insertEntitlement(client, accountId, periodId, enrollment.grant_amount, {
    enrollment_status: enrollment.status,
    grant_amount: enrollment.grant_amount,
    initial_allocated: enrollment.grant_amount,
  });
}

/**
 * Step 1: concurrency-safe permanent admission. Idempotent: verification
 * retries return the existing enrollment without touching counters.
 */
export async function admitAccount(accountId: string, actor = "verification", now = new Date()): Promise<AdmissionOutcome> {
  return withOperatorTransaction((client) => admitAccountWithClient(client, accountId, actor, now));
}

/** Transaction-scoped admission used by verification and other callers that already own a client. */
export async function admitAccountWithClient(
  client: DatabaseClient,
  accountId: string,
  actor = "verification",
  now = new Date(),
): Promise<AdmissionOutcome> {
  // Serialize the account lookup and first enrollment attempt behind the
  // singleton policy row. Locking only a missing enrollment row leaves no
  // PostgreSQL row/gap lock for concurrent first-time admissions.
  const policy = await repo.lockPolicy(client);
  if (!policy) throw new Error("Free tier policy row is missing");
  const existing = await repo.lockEnrollment(client, accountId);
  if (existing) {
    return existing.status === "revoked"
      ? { status: "revoked" as const, enrollment: existing }
      : existing.status === "enrolled"
        ? { status: "enrolled" as const, enrollment: existing, entitlement: await repo.getEntitlement(client, accountId, currentPeriodRange(now).id) }
        : { status: "waitlisted" as const, enrollment: existing };
  }

  // Admission rule: only verified, active accounts may hold a permanent slot.
  // Check BEFORE any capacity commitment so an ineligible account can never
  // consume a slot without receiving an entitlement.
  if (!(await isAccountEligible(client, accountId))) {
    throw new PolicyValidationError(
      "Account is not eligible for free-tier admission: the email must be verified and the account active",
    );
  }
  const grant = grantForPeriod(policy, currentPeriodRange(now).id);
  const committed = await repo.incrementCommitment(client, grant);
  if (!committed) {
    const enrollment = await repo.insertEnrollment(client, accountId, "waitlisted", grant, actor, "capacity");
    await detectCommitmentAndWaitlist(client, policy);
    return { status: "waitlisted", enrollment };
  }
  const enrollment = await repo.insertEnrollment(client, accountId, "enrolled", grant, actor, `admitted by ${actor}`);
  const range = currentPeriodRange(now);
  const entitlement = await ensureEntitlementFor(client, accountId, range.id);
  const currentPolicy = await repo.lockPolicy(client);
  await detectCommitmentAndWaitlist(client, currentPolicy ?? policy);
  return { status: "enrolled", enrollment, entitlement };
}

/** Step 3: open the current UTC month and issue entitlements idempotently. */
export async function openNextPeriod(now = new Date()): Promise<{ period: QuotaPeriodRecord; issued: number }> {
  return withOperatorTransaction(async (client) => {
    const policy = await repo.lockPolicy(client);
    if (!policy) throw new Error("Free tier policy row is missing");
    const range = currentPeriodRange(now);
    const period = await repo.upsertPeriod(client, range.id, range.start, range.end, policy.hard_monthly_cap);

    await applyScheduledChanges(client, policy, range.id, period);
    const issued = await repo.issueEntitlementsForPeriod(client, range.id);

    // Unused prior-period allowance expires: close any open past periods.
    await client.query(
      `UPDATE quota_periods SET status = 'closed', updated_at = NOW()
       WHERE status = 'open' AND period_end <= $1`,
      [now.toISOString()],
    );
    await detectConsumption(client, period);
    return { period, issued };
  });
}

/** Apply scheduled next-period changes to the policy and enrollments. */
async function applyScheduledChanges(
  client: DatabaseClient,
  policy: FreeTierPolicyRecord,
  periodId: string,
  period: QuotaPeriodRecord,
): Promise<boolean> {
  const scheduled = (policy.next_period_changes ?? []).filter((change) => change.period_id === periodId);
  if (scheduled.length === 0) return false;

  const before = { ...policy };
  const requestedGrant = [...scheduled].reverse().find(
    (change) => typeof change.default_grant === "number" && change.default_grant > 0,
  )?.default_grant as number | undefined;
  const requestedCeiling = [...scheduled].reverse().find(
    (change) => typeof change.commitment_ceiling === "number",
  )?.commitment_ceiling as number | undefined;
  const requestedHardCap = [...scheduled].reverse().find(
    (change) => typeof change.hard_monthly_cap === "number" && change.hard_monthly_cap >= 0,
  )?.hard_monthly_cap as number | undefined;

  // Apply the new ceiling before changing grants. Otherwise a grant increase
  // can be rejected against the old ceiling and then lost when the schedule is
  // removed.
  if (requestedCeiling !== undefined) {
    if (requestedCeiling < policy.committed_amount) {
      logger.warn({ periodId }, "Scheduled ceiling change would fall below committed amount; ignored");
    } else {
      policy.commitment_ceiling = requestedCeiling;
    }
  }
  if (requestedGrant !== undefined) policy.default_grant = requestedGrant;
  if (requestedHardCap !== undefined) policy.hard_monthly_cap = requestedHardCap;

  const scalarChanged =
    policy.default_grant !== before.default_grant ||
    policy.commitment_ceiling !== before.commitment_ceiling ||
    policy.hard_monthly_cap !== before.hard_monthly_cap;
  if (scalarChanged) {
    await client.query(
      `UPDATE free_tier_policy
       SET default_grant = $1, commitment_ceiling = $2, hard_monthly_cap = $3,
           version = version + 1, updated_at = NOW()
       WHERE id = 'default'`,
      [policy.default_grant, policy.commitment_ceiling, policy.hard_monthly_cap],
    );
    policy.version += 1;
    if (period.status === "open" && policy.hard_monthly_cap !== period.hard_cap) {
      await client.query(
        `UPDATE quota_periods SET hard_cap = $2, updated_at = NOW() WHERE id = $1`,
        [period.id, policy.hard_monthly_cap],
      );
      period.hard_cap = policy.hard_monthly_cap;
    }
  }

  if (requestedGrant !== undefined) {
    // The ceiling update above is committed in this transaction before this
    // guarded per-enrollment grant update, so a valid scheduled increase fits.
    const delta = await applyGrantChangeToEnrollments(client, requestedGrant);
    policy.committed_amount += delta.commitmentDelta;
    policy.version += delta.applied;
    if (delta.skipped > 0) {
      logger.warn({ periodId, skipped: delta.skipped }, "Scheduled grant change could not fit the commitment ceiling");
    }
  }

  // Consume the schedule only after all applicable changes have been applied.
  const remaining = (policy.next_period_changes ?? []).filter((change) => change.period_id !== periodId);
  await client.query(
    `UPDATE free_tier_policy
     SET next_period_changes = $1::jsonb, version = version + 1, updated_at = NOW()
     WHERE id = 'default'`,
    [JSON.stringify(remaining)],
  );
  policy.version += 1;
  await appendPolicyChange(client, before, policy, "quota-worker", `scheduled change applied for ${periodId}`);

  // Scheduled grant changes can cross commitment thresholds without any
  // admission or waitlist activity afterward. Evaluate the committed state
  // after all policy/enrollment mutations and before the transaction commits.
  const currentPolicy = await repo.lockPolicy(client);
  await detectCommitmentAndWaitlist(client, currentPolicy ?? policy);
  return true;
}

async function applyGrantChangeToEnrollments(
  client: DatabaseClient,
  newGrant: number,
): Promise<{ applied: number; skipped: number; commitmentDelta: number }> {
  const result = await client.query<{ account_id: string; grant_amount: number }>(
    `SELECT account_id, grant_amount FROM free_tier_enrollments
     WHERE status = 'enrolled' AND grant_amount <> $1 FOR UPDATE`,
    [newGrant],
  );
  let applied = 0;
  let skipped = 0;
  let commitmentDelta = 0;
  for (const row of result.rows) {
    const delta = newGrant - row.grant_amount;
    if (delta > 0) {
      const ok = await client.query(
        `UPDATE free_tier_policy
         SET committed_amount = committed_amount + $1, version = version + 1, updated_at = NOW()
         WHERE id = 'default' AND committed_amount + $1 <= commitment_ceiling`,
        [delta],
      );
      if ((ok.rowCount ?? 0) === 0) {
        skipped += 1;
        continue;
      }
    } else if (delta < 0) {
      await client.query(
        `UPDATE free_tier_policy
         SET committed_amount = GREATEST(committed_amount + $1, 0), version = version + 1, updated_at = NOW()
         WHERE id = 'default'`,
        [delta],
      );
    }
    commitmentDelta += delta;
    await client.query(
      `UPDATE free_tier_enrollments SET grant_amount = $2, updated_at = NOW() WHERE account_id = $1`,
      [row.account_id, newGrant],
    );
    applied += 1;
  }
  return { applied, skipped, commitmentDelta };
}

function appendPolicyChange(
  client: DatabaseClient,
  before: FreeTierPolicyRecord,
  after: FreeTierPolicyRecord,
  actor: string,
  reason: string,
): Promise<unknown> {
  return client.query(
    `UPDATE free_tier_policy
     SET policy_change_log = policy_change_log || $1::jsonb, updated_by = $2, updated_at = NOW()
     WHERE id = 'default'`,
    [
      JSON.stringify([{ at: new Date().toISOString(), actor, reason, before, after }]),
      actor,
    ],
  );
}

/**
 * Step 4: atomically reserve one included request against both the account
 * entitlement and the platform period cap. Idempotent by a server-owned
 * per-HTTP-request quota id.
 */
export async function reserveIncluded(
  accountId: string,
  requestId: string,
  now = new Date(),
): Promise<QuotaReservation | QuotaRejection> {
  try {
    return await withOperatorTransaction(async (client) => {
      const policy = await repo.lockPolicy(client);
      if (!policy) throw new Error("Free tier policy row is missing");
      if (!policy.included_traffic_enabled) {
        throwRejection("quota_paused", "Included infrastructure traffic is paused by an operator", 503);
      }

      const range = currentPeriodRange(now);
      const period = await repo.upsertPeriod(client, range.id, range.start, range.end, policy.hard_monthly_cap);
      if (period.status !== "open") {
        throwRejection("quota_paused", "The current quota period is not open", 503);
      }
      // The API is a correctness path, not just a consumer of the hourly
      // worker: apply a pending period change before issuing a lazy entitlement.
      await applyScheduledChanges(client, policy, range.id, period);

      // Lazy recovery path: correctness never depends on one cron execution.
      // Resolve the entitlement BEFORE claiming the key so the reservation
      // row can satisfy its FK; an ineligible account is rejected here.
      const entitlement = await ensureEntitlementFor(client, accountId, range.id);
      if (!entitlement) {
        throwRejection("no_entitlement", "No included entitlement for this account this month", 403);
      }

      // Idempotency: claim the reservation key BEFORE any counter movement so
      // concurrent duplicates serialize on the row instead of double-bumping.
      // The key is namespaced by account and period, so a client request id
      // can never collide across accounts, and a same-account retry in a later
      // month starts a fresh reservation for that period instead of replaying
      // the previous month's consumed row (which would neither reserve nor
      // charge the new period).
      const reservationId = `${accountId}:${requestId}:${period.id}`;
      const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
      let reservation = await repo.insertReservation(client, { id: reservationId, accountId, periodId: period.id, entitlementId: entitlement.id, expiresAt });
      if (!reservation) {
        const winner = await repo.lockReservation(client, reservationId);
        if (!winner) {
          // The conflicting insert rolled back concurrently; claim the key now.
          reservation = await repo.insertReservation(client, { id: reservationId, accountId, periodId: period.id, entitlementId: entitlement.id, expiresAt });
          if (!reservation) throw new Error("Unable to create quota reservation");
        } else if (winner.status === "released") {
          // Retry after a pre-dispatch failure: re-arm the row and re-bump the
          // counters below in this transaction.
          reservation = winner;
        } else {
          // Idempotent replay of the same request in the same period: counters
          // are already reserved/charged by the original reservation. Do not
          // re-bump, and never answer with a fresh reservation.
          return reservationResult(winner, entitlement, period);
        }
      }

      const accountSlot = await repo.reserveAccountSlot(client, accountId, period.id);
      if (!accountSlot) {
        const current = await repo.getEntitlement(client, accountId, period.id);
        if (!current) throwRejection("no_entitlement", "No included entitlement for this account this month", 403);
        if (current.status !== "active") throwRejection("quota_paused", "The account entitlement is not active", 403);
        throwRejection("quota_exhausted", "Included request allowance exhausted for this month", 429);
      }

      const periodSlot = await repo.reservePeriodSlot(client, period.id);
      if (!periodSlot) {
        const current = await repo.getPeriod(client, period.id);
        if (!current || current.status !== "open") throwRejection("quota_paused", "The current quota period is not open", 503);
        throwRejection("quota_hard_cap", "Platform hard capacity reached for this month", 429);
      }

      if (reservation.status === "released") {
        // Re-arm the released row and re-bump the counters in this transaction.
        await repo.rearmReservation(client, reservation.id, expiresAt);
      }
      return reservationResult(reservation, accountSlot, period);
    });
  } catch (error) {
    if (error instanceof QuotaRejectionError) return error.rejection;
    throw error;
  }
}

function reservationResult(
  reservation: { id: string },
  entitlement: AccountEntitlementRecord,
  period: QuotaPeriodRecord,
): QuotaReservation {
  return {
    reservationId: reservation.id,
    reserved: true,
    limit: entitlement.allocated,
    remaining: entitlement.allocated - entitlement.consumed - entitlement.reserved,
    resetAt: period.period_end,
    periodId: period.id,
    entitlementId: entitlement.id,
  };
}

/** Charge exactly once after any operator-infrastructure dispatch. */
export async function finalizeReservation(reservationId: string, reason = "operator dispatch"): Promise<boolean> {
  return withOperatorTransaction(async (client) => {
    const reservation = await repo.finalizeReservation(client, reservationId, reason);
    if (reservation) {
      const period = await repo.getPeriod(client, reservation.period_id);
      if (period) await detectConsumption(client, period);
    }
    return Boolean(reservation);
  });
}

/** Release a reservation when failure happened before any dispatch. */
export async function releaseReservation(reservationId: string): Promise<boolean> {
  return withOperatorTransaction(async (client) => {
    const reservation = await repo.releaseReservation(client, reservationId);
    return Boolean(reservation);
  });
}

/** Crash recovery: expired in-flight reservations are charged conservatively. */
export async function reconcileExpiredReservations(batch = WAITLIST_BATCH): Promise<number> {
  return withOperatorTransaction(async (client) => {
    const expired = await repo.listExpiredReservations(client, batch);
    let charged = 0;
    for (const reservation of expired) {
      const finalized = await repo.finalizeReservation(client, reservation.id, "reconciliation: expired in-flight reservation");
      if (finalized) charged += 1;
    }
    return charged;
  });
}

/** Step 2: suspension blocks spending without freeing the permanent slot. */
export async function suspendAccountEntitlements(accountId: string): Promise<number> {
  return withOperatorTransaction((client) => suspendAccountEntitlementsWithClient(client, accountId));
}

/** Transaction-scoped quota suspension used by user status transitions. */
export async function suspendAccountEntitlementsWithClient(
  client: DatabaseClient,
  accountId: string,
): Promise<number> {
  const updated = await repo.setEntitlementStatusForAccount(client, accountId, "suspended");
  if (updated > 0) logger.info({ accountId, updated }, "Suspended account entitlements");
  return updated;
}

/** Reactivation resumes the remaining entitlement or issues one for the period. */
export async function resumeAccountEntitlements(accountId: string, now = new Date()): Promise<AccountEntitlementRecord | null> {
  return withOperatorTransaction((client) => resumeAccountEntitlementsWithClient(client, accountId, now));
}

/** Transaction-scoped quota resume used by authentication reactivation flows. */
export async function resumeAccountEntitlementsWithClient(
  client: DatabaseClient,
  accountId: string,
  now = new Date(),
): Promise<AccountEntitlementRecord | null> {
  const policy = await repo.lockPolicy(client);
  if (!policy) throw new Error("Free tier policy row is missing");
  const range = currentPeriodRange(now);
  const period = await repo.upsertPeriod(client, range.id, range.start, range.end, policy.hard_monthly_cap);
  if (period.status !== "open") throw new Error("Current quota period is not open");
  // Expiry reactivation is another lazy period-entry path; scheduled grant
  // and cap changes must be applied before restoring or creating entitlement.
  await applyScheduledChanges(client, policy, range.id, period);
  await repo.setEntitlementStatusForAccount(client, accountId, "active");
  return ensureEntitlementFor(client, accountId, range.id);
}

/** Explicit free-tier revocation releases the permanent slot exactly once. */
export async function revokeFreeTier(
  accountId: string,
  actor: string,
  reason: string,
): Promise<FreeTierEnrollmentRecord | null> {
  return withOperatorTransaction(async (client) => {
    // Match admission's policy-first lock order so revocation cannot deadlock
    // with a concurrent first-time admission.
    const lockedPolicy = await repo.lockPolicy(client);
    if (!lockedPolicy) throw new Error("Free tier policy row is missing");
    const enrollment = await repo.lockEnrollment(client, accountId);
    if (!enrollment) throw new Error("Account has no free-tier enrollment");
    if (enrollment.status === "revoked") return enrollment;

    const wasEnrolled = enrollment.status === "enrolled";
    const updated = await repo.updateEnrollmentStatus(client, accountId, "revoked", actor, reason);
    if (!updated) throw new Error("Unable to revoke free-tier enrollment");
    if (wasEnrolled) {
      await repo.decrementCommitment(client, enrollment.grant_amount);
      await repo.setEntitlementStatusForAccount(client, accountId, "revoked");
      await repo.insertAdjustmentEvent(client, {
        requestId: `revoke:${accountId}:${crypto.randomUUID()}`,
        accountId,
        periodId: null,
        amount: -enrollment.grant_amount,
        actor,
        reason: `revoke free-tier: ${reason}`,
      });
    }
    const policy = await repo.lockPolicy(client);
    if (policy) await detectCommitmentAndWaitlist(client, policy);
    return updated;
  });
}

/** Manual admission re-checks capacity; revoked accounts may re-enter. */
export async function manualAdmit(accountId: string, actor: string, reason = "manual admit", now = new Date()): Promise<AdmissionOutcome> {
  return withOperatorTransaction(async (client) => {
    // Serialize all admission paths on the policy row before checking for an
    // enrollment. A missing enrollment has no row lock to protect a first
    // concurrent admission.
    const policy = await repo.lockPolicy(client);
    if (!policy) throw new Error("Free tier policy row is missing");
    const existing = await repo.lockEnrollment(client, accountId);
    if (!policy.admissions_enabled) {
      if (existing?.status === "waitlisted") {
        await repo.markWaitlistSkipped(client, accountId, actor, "admissions paused");
      }
      throwRejection("quota_paused", "New grants are paused by an operator", 409);
    }

    const grant = existing?.grant_amount ?? grantForPeriod(policy, currentPeriodRange(now).id);
    if (existing?.status === "enrolled") {
      const range = currentPeriodRange(now);
      const entitlement = await ensureEntitlementFor(client, accountId, range.id);
      return { status: "enrolled", enrollment: existing, entitlement };
    }

    // Admission rule: only verified, active accounts may claim a slot. Check
    // before any capacity commitment; an ineligible account must never consume
    // a permanent slot without receiving an entitlement.
    if (!(await isAccountEligible(client, accountId))) {
      throw new PolicyValidationError(
        "Account is not eligible for free-tier admission: the email must be verified and the account active",
      );
    }

    if (existing?.status === "revoked") {
      // Re-entering after revocation restores the slot under the ceiling.
      const committed = await repo.incrementCommitment(client, grant);
      if (!committed) {
        const enrollment = await repo.updateEnrollmentStatus(client, accountId, "waitlisted", actor, reason);
        await detectCommitmentAndWaitlist(client, policy);
        return { status: "waitlisted", enrollment: enrollment ?? existing };
      }
      const enrollment = await repo.updateEnrollmentStatus(client, accountId, "enrolled", actor, reason);
      if (!enrollment) throw new Error("Unable to re-enroll revoked account");
      const range = currentPeriodRange(now);
      const entitlement = await ensureEntitlementFor(client, accountId, range.id);
      const currentPolicy = await repo.lockPolicy(client);
      await detectCommitmentAndWaitlist(client, currentPolicy ?? policy);
      return { status: "enrolled", enrollment, entitlement };
    }

    if (existing?.status === "waitlisted") {
      // Waitlisted rows never held a committed slot, so promotion must claim
      // capacity under the ceiling exactly like any other admission; otherwise
      // committed_amount would no longer equal the enrolled grant total.
      const committed = await repo.incrementCommitment(client, grant);
      if (!committed) {
        await detectCommitmentAndWaitlist(client, policy);
        return { status: "waitlisted", enrollment: existing };
      }
      const enrollment = await repo.updateEnrollmentStatus(client, accountId, "enrolled", actor, reason);
      if (!enrollment) throw new Error("Unable to admit waitlisted account");
      const range = currentPeriodRange(now);
      const entitlement = await ensureEntitlementFor(client, accountId, range.id);
      const currentPolicy = await repo.lockPolicy(client);
      await detectCommitmentAndWaitlist(client, currentPolicy ?? policy);
      return { status: "enrolled", enrollment, entitlement };
    }

    // No enrollment row yet: commit and insert atomically, idempotent on retry.
    const committed = await repo.incrementCommitment(client, grant);
    if (!committed) {
      const enrollment = await repo.insertEnrollment(client, accountId, "waitlisted", grant, actor, reason);
      await detectCommitmentAndWaitlist(client, policy);
      return { status: "waitlisted", enrollment };
    }
    const enrollment = await repo.insertEnrollment(client, accountId, "enrolled", grant, actor, reason);
    const range = currentPeriodRange(now);
    const entitlement = await ensureEntitlementFor(client, accountId, range.id);
    const currentPolicy = await repo.lockPolicy(client);
    await detectCommitmentAndWaitlist(client, currentPolicy ?? policy);
    return { status: "enrolled", enrollment, entitlement };
  });
}

/** Skip-with-reason keeps the row on the waitlist but out of automatic claims. */
export async function skipWaitlist(accountId: string, actor: string, reason: string): Promise<FreeTierEnrollmentRecord | null> {
  return withOperatorTransaction(async (client) => {
    const enrollment = await repo.markWaitlistSkipped(client, accountId, actor, reason);
    return enrollment;
  });
}

/** Step 6: FIFO waitlist processing that never overcommits. */
export async function processWaitlist(batch = WAITLIST_BATCH, now = new Date()): Promise<WaitlistProcessingResult> {
  return withOperatorTransaction(async (client) => {
    const policy = await repo.lockPolicy(client);
    if (!policy) throw new Error("Free tier policy row is missing");
    const remaining = await repo.countWaitlist(client);
    if (!policy.admissions_enabled) {
      return { admitted: 0, claimed: 0, stoppedReason: "paused", remaining };
    }
    const candidates = await repo.claimWaitlistCandidates(client, batch);
    if (candidates.length === 0) {
      return { admitted: 0, claimed: 0, stoppedReason: "empty", remaining };
    }

    let admitted = 0;
    let stoppedReason: WaitlistProcessingResult["stoppedReason"] = "empty";
    const range = currentPeriodRange(now);
    for (const candidate of candidates) {
      const committed = await repo.incrementCommitment(client, candidate.grant_amount);
      if (!committed) {
        stoppedReason = "capacity";
        break;
      }
      const enrollment = await repo.updateEnrollmentStatus(client, candidate.account_id, "enrolled", "waitlist-worker", "automatic admit");
      if (enrollment) {
        await ensureEntitlementFor(client, candidate.account_id, range.id);
        admitted += 1;
      }
    }
    if (admitted > 0 && admitted === candidates.length) stoppedReason = "empty";
    const currentPolicy = await repo.lockPolicy(client);
    await detectCommitmentAndWaitlist(client, currentPolicy ?? policy);
    return { admitted, claimed: candidates.length, stoppedReason, remaining: await repo.countWaitlist(client) };
  });
}

/** Step 7: operator controls with server-side invariant validation. */

export async function getPolicy(): Promise<FreeTierPolicyRecord | null> {
  return withOperatorTransaction(async (client) => repo.getPolicy(client));
}

export async function updatePolicy(input: PolicyUpdateInput): Promise<{ before: FreeTierPolicyRecord; after: FreeTierPolicyRecord }> {
  return withOperatorTransaction(async (client) => {
    const before = await repo.lockPolicy(client);
    if (!before) throw new Error("Free tier policy row is missing");

    const next: FreeTierPolicyRecord = { ...before };
    let openPeriodId: string | null = null;
    if (input.defaultGrant !== undefined) {
      if (!Number.isInteger(input.defaultGrant) || input.defaultGrant <= 0) {
        throw new PolicyValidationError("default_grant must be a positive integer");
      }
      next.default_grant = input.defaultGrant;
    }
    if (input.commitmentCeiling !== undefined) {
      if (!Number.isInteger(input.commitmentCeiling) || input.commitmentCeiling < 0) {
        throw new PolicyValidationError("commitment_ceiling must be a non-negative integer");
      }
      if (input.commitmentCeiling < before.committed_amount) {
        throw new PolicyValidationError(
          `commitment_ceiling cannot be lowered below the committed amount (${before.committed_amount})`,
        );
      }
      next.commitment_ceiling = input.commitmentCeiling;
    }
    if (input.hardMonthlyCap !== undefined) {
      if (!Number.isInteger(input.hardMonthlyCap) || input.hardMonthlyCap < 0) {
        throw new PolicyValidationError("hard_monthly_cap must be a non-negative integer");
      }
      if (input.hardMonthlyCap !== before.hard_monthly_cap) {
        // Lock the open period row before reading usage: reservations hold the
        // same row lock until commit (reservePeriodSlot), so a concurrent
        // reserve can neither commit between this read and the cap update nor
        // leave consumed + reserved above the new cap.
        const open = await repo.lockOpenPeriod(client);
        openPeriodId = open?.id ?? null;
        const inUse = open ? Number(open.consumed) + Number(open.reserved) : 0;
        if (inUse > input.hardMonthlyCap) {
          throw new PolicyValidationError(
            `hard_monthly_cap cannot be lowered below the current open-period usage (${inUse})`,
          );
        }
      }
      next.hard_monthly_cap = input.hardMonthlyCap;
    }
    if (input.admissionsEnabled !== undefined) next.admissions_enabled = input.admissionsEnabled;
    if (input.includedTrafficEnabled !== undefined) next.included_traffic_enabled = input.includedTrafficEnabled;
    if (input.warningThresholds !== undefined) next.warning_thresholds = input.warningThresholds;

    await client.query(
      `UPDATE free_tier_policy
       SET default_grant = $2, commitment_ceiling = $3, hard_monthly_cap = $4,
           admissions_enabled = $5, included_traffic_enabled = $6,
           warning_thresholds = $7::jsonb, version = version + 1,
           policy_change_log = policy_change_log || $8::jsonb,
           updated_by = $9, updated_at = NOW()
       WHERE id = 'default'`,
      [
        next.default_grant,
        next.commitment_ceiling,
        next.hard_monthly_cap,
        next.admissions_enabled,
        next.included_traffic_enabled,
        JSON.stringify(next.warning_thresholds),
        JSON.stringify([{ at: new Date().toISOString(), actor: input.actor, reason: input.reason ?? null, before, after: next }]),
        input.actor,
      ],
    );

    if (input.hardMonthlyCap !== undefined && input.hardMonthlyCap !== before.hard_monthly_cap && openPeriodId) {
      // Apply the new ceiling to the open current period immediately. The row
      // is already locked by the validation above, so this cannot race.
      await client.query(
        `UPDATE quota_periods SET hard_cap = $1, updated_at = NOW() WHERE id = $2`,
        [input.hardMonthlyCap, openPeriodId],
      );
    }
    if (input.admissionsEnabled !== undefined || input.commitmentCeiling !== undefined) {
      await detectCommitmentAndWaitlist(client, next);
    }
    return { before, after: next };
  });
}

export async function schedulePeriodChange(input: PeriodChangeInput & { actor: string; reason: string }) {
  return withOperatorTransaction(async (client) => {
    const policy = await repo.lockPolicy(client);
    if (!policy) throw new Error("Free tier policy row is missing");
    const period = await repo.getPeriod(client, input.periodId);
    if (period && period.period_start <= new Date().toISOString()) {
      throw new PolicyValidationError("Scheduled changes apply only to future periods");
    }

    const entry: Record<string, unknown> = { period_id: input.periodId, scheduled_at: new Date().toISOString() };
    if (input.defaultGrant !== undefined) {
      if (!Number.isInteger(input.defaultGrant) || input.defaultGrant <= 0) {
        throw new PolicyValidationError("default_grant must be a positive integer");
      }
      entry.default_grant = input.defaultGrant;
    }
    if (input.commitmentCeiling !== undefined) {
      if (!Number.isInteger(input.commitmentCeiling) || input.commitmentCeiling < 0) {
        throw new PolicyValidationError("commitment_ceiling must be a non-negative integer");
      }
      if (input.commitmentCeiling < policy.committed_amount) {
        throw new PolicyValidationError(
          `commitment_ceiling cannot be scheduled below the committed amount (${policy.committed_amount})`,
        );
      }
      entry.commitment_ceiling = input.commitmentCeiling;
    }
    if (input.hardMonthlyCap !== undefined) {
      if (!Number.isInteger(input.hardMonthlyCap) || input.hardMonthlyCap < 0) {
        throw new PolicyValidationError("hard_monthly_cap must be a non-negative integer");
      }
      entry.hard_monthly_cap = input.hardMonthlyCap;
    }

    const updated = await client.query<FreeTierPolicyRecord>(
      `UPDATE free_tier_policy
       SET next_period_changes = next_period_changes || $1::jsonb, version = version + 1,
           policy_change_log = policy_change_log || $2::jsonb, updated_by = $3, updated_at = NOW()
       WHERE id = 'default' RETURNING *`,
      [
        JSON.stringify([entry]),
        JSON.stringify([{ at: new Date().toISOString(), actor: input.actor, reason: input.reason, before: policy, after: entry }]),
        input.actor,
      ],
    );
    return updated.rows[0] ?? null;
  });
}

/** Individual allowance changes through the immutable ledger, bounded by policy. */
export async function adjustAllowance(
  accountId: string,
  amount: number,
  actor: string,
  reason: string,
  now = new Date(),
): Promise<AccountEntitlementRecord> {
  if (!Number.isInteger(amount) || amount === 0) {
    throw new Error("Adjustment amount must be a non-zero integer");
  }
  return withOperatorTransaction(async (client) => {
    const policy = await repo.getPolicy(client);
    if (!policy) throw new Error("Free tier policy row is missing");
    const range = currentPeriodRange(now);
    const period = await repo.upsertPeriod(client, range.id, range.start, range.end, policy.hard_monthly_cap);
    if (period.status !== "open") throw new Error("The current quota period is not open");

    const entitlement = await repo.getEntitlement(client, accountId, range.id);
    if (!entitlement) throw new Error("Account has no entitlement for the current period");
    if (entitlement.status !== "active") throw new Error("The account entitlement is not active");

    const newAllocated = entitlement.allocated + amount;
    if (newAllocated < entitlement.consumed + entitlement.reserved) {
      throw new Error(
        `Reduction below used allowance is not allowed (used ${entitlement.consumed + entitlement.reserved})`,
      );
    }
    if (newAllocated > period.hard_cap) {
      throw new Error(`Increase above the period hard cap (${period.hard_cap}) is not allowed`);
    }

    const result = await client.query<AccountEntitlementRecord>(
      `UPDATE account_entitlements SET allocated = $3, updated_at = NOW()
       WHERE account_id = $1 AND period_id = $2 RETURNING *`,
      [accountId, range.id, newAllocated],
    );
    await repo.insertAdjustmentEvent(client, {
      requestId: `adjust:${accountId}:${range.id}:${crypto.randomUUID()}`,
      accountId,
      periodId: range.id,
      amount,
      actor,
      reason,
    });
    return result.rows[0];
  });
}

/** Operator summary: committed, remaining slots, waitlist, current usage. */
export async function getPolicySummary() {
  return withOperatorTransaction(async (client) => {
    const policy = await repo.getPolicy(client);
    if (!policy) throw new Error("Free tier policy row is missing");
    const range = currentPeriodRange(new Date());
    const period = await repo.getPeriod(client, range.id);
    const waitlist = await repo.countWaitlist(client);
    const entitlementStats = await client.query<{ accounts: string; allocated: string; reserved: string; consumed: string }>(
      `SELECT COUNT(*) AS accounts, COALESCE(SUM(allocated), 0) AS allocated,
              COALESCE(SUM(reserved), 0) AS reserved, COALESCE(SUM(consumed), 0) AS consumed
       FROM account_entitlements WHERE period_id = $1`,
      [range.id],
    );
    const slotsRemaining = Math.max(policy.commitment_ceiling - policy.committed_amount, 0);
    return {
      policy,
      period: period ?? null,
      waitlist,
      slotsRemaining,
      entitlements: entitlementStats.rows[0]
        ? {
            accounts: Number(entitlementStats.rows[0].accounts),
            allocated: Number(entitlementStats.rows[0].allocated),
            reserved: Number(entitlementStats.rows[0].reserved),
            consumed: Number(entitlementStats.rows[0].consumed),
          }
        : null,
    };
  });
}

export async function listQuotaEvents(limit = 100) {
  return withOperatorTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM quota_events ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows;
  });
}

export async function listWaitlist(limit = 100) {
  return withOperatorTransaction(async (client) => {
    const result = await client.query(
      `SELECT e.*, a.display_name, u.email, u.status AS user_status, a.status AS account_status
       FROM free_tier_enrollments e
       INNER JOIN accounts a ON a.id = e.account_id
       INNER JOIN account_memberships m ON m.account_id = e.account_id AND m.role = 'owner'
       INNER JOIN users u ON u.id = m.user_id
       WHERE e.status = 'waitlisted'
       ORDER BY e.waitlisted_at ASC, e.account_id ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  });
}

export async function listEntitlements(limit = 100) {
  return withOperatorTransaction(async (client) => {
    const result = await client.query(
      `SELECT ae.*, a.display_name, u.email
       FROM account_entitlements ae
       INNER JOIN accounts a ON a.id = ae.account_id
       INNER JOIN account_memberships m ON m.account_id = ae.account_id AND m.role = 'owner'
       INNER JOIN users u ON u.id = m.user_id
       ORDER BY ae.updated_at DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  });
}

/**
 * Operational invariant: read-only reconciliation. Reports mismatches between
 * the immutable ledger and denormalized counters; never repairs automatically.
 */
export async function reconcile(periodId?: string): Promise<ReconciliationReport> {
  return withOperatorTransaction(async (client) => {
    const range = currentPeriodRange(new Date());
    const targetPeriod = periodId ?? range.id;
    const checks: ReconciliationReport["checks"] = [];
    const report = (name: string, status: "ok" | "mismatch", details: string) => checks.push({ name, status, details });

    // 1. Policy commitment equals the sum of enrolled grants.
    const commitment = await client.query<{ expected: string }>(
      `SELECT COALESCE(SUM(grant_amount), 0) AS expected
       FROM free_tier_enrollments WHERE status = 'enrolled'`,
    );
    const policy = await repo.getPolicy(client);
    const expectedCommitted = Number(commitment.rows[0]?.expected ?? 0);
    report(
      "policy_commitment_matches_enrollments",
      policy && policy.committed_amount === expectedCommitted ? "ok" : "mismatch",
      `committed_amount=${policy?.committed_amount ?? "n/a"} sum(enrolled grants)=${expectedCommitted}`,
    );

    // 2. Entitlement counters equal the sum of immutable charge events.
    const charges = await client.query<{ account_id: string; charged: string }>(
      `SELECT account_id, COALESCE(SUM(amount), 0) AS charged
       FROM usage_events WHERE kind = 'charge' AND period_id = $1 GROUP BY account_id`,
      [targetPeriod],
    );
    const chargeByAccount = new Map(charges.rows.map((row) => [row.account_id, Number(row.charged)]));
    const entitlements = await client.query<AccountEntitlementRecord>(
      `SELECT * FROM account_entitlements WHERE period_id = $1`,
      [targetPeriod],
    );
    const chargeMismatches: string[] = [];
    for (const entitlement of entitlements.rows) {
      const charged = chargeByAccount.get(entitlement.account_id) ?? 0;
      if (entitlement.consumed !== charged) {
        chargeMismatches.push(`${entitlement.account_id}: consumed=${entitlement.consumed} ledger=${charged}`);
      }
      if (entitlement.consumed + entitlement.reserved > entitlement.allocated) {
        chargeMismatches.push(`${entitlement.account_id}: consumed+reserved=${entitlement.consumed + entitlement.reserved} allocated=${entitlement.allocated}`);
      }
      const initialAllocated = Number(entitlement.enrollment_snapshot?.initial_allocated ?? entitlement.allocated);
      const adjustments = await client.query<{ adjusted: string }>(
        `SELECT COALESCE(SUM(amount), 0) AS adjusted FROM usage_events
         WHERE kind = 'adjustment' AND account_id = $1 AND period_id = $2`,
        [entitlement.account_id, targetPeriod],
      );
      if (entitlement.allocated - initialAllocated !== Number(adjustments.rows[0]?.adjusted ?? 0)) {
        chargeMismatches.push(`${entitlement.account_id}: allocated delta=${entitlement.allocated - initialAllocated} ledger=${adjustments.rows[0]?.adjusted ?? 0}`);
      }
    }
    report("entitlement_counters_match_ledger", chargeMismatches.length === 0 ? "ok" : "mismatch", chargeMismatches.join("; ") || "all equal");

    // 3. In-flight reservations reconcile with reserved counters.
    const reservations = await client.query<{ entitlement_id: string; reserved: string }>(
      `SELECT entitlement_id, COUNT(*) AS reserved FROM usage_reservations
       WHERE status = 'reserved' GROUP BY entitlement_id`,
    );
    const reservedByEntitlement = new Map(reservations.rows.map((row) => [row.entitlement_id, Number(row.reserved)]));
    const reservationMismatches: string[] = [];
    for (const entitlement of entitlements.rows) {
      const inFlight = reservedByEntitlement.get(entitlement.id) ?? 0;
      if (entitlement.reserved !== inFlight) {
        reservationMismatches.push(`${entitlement.account_id}: reserved=${entitlement.reserved} in-flight=${inFlight}`);
      }
    }
    report(
      "reservation_counters_match_in_flight",
      reservationMismatches.length === 0 ? "ok" : "mismatch",
      reservationMismatches.join("; ") || "all equal",
    );

    // 4. Period counters equal the sum of entitlement counters.
    const period = await repo.getPeriod(client, targetPeriod);
    if (period) {
      const periodSums = await client.query<{ consumed: string; reserved: string }>(
        `SELECT COALESCE(SUM(consumed), 0) AS consumed, COALESCE(SUM(reserved), 0) AS reserved
         FROM account_entitlements WHERE period_id = $1`,
        [targetPeriod],
      );
      const mismatch =
        period.consumed !== Number(periodSums.rows[0]?.consumed ?? 0) ||
        period.reserved !== Number(periodSums.rows[0]?.reserved ?? 0);
      report(
        "period_counters_match_entitlements",
        mismatch ? "mismatch" : "ok",
        mismatch
          ? `period consumed=${period.consumed} reserved=${period.reserved}; entitlements consumed=${periodSums.rows[0]?.consumed} reserved=${periodSums.rows[0]?.reserved}`
          : "all equal",
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      periodId: targetPeriod,
      checks,
      mismatches: checks.filter((check) => check.status === "mismatch").length,
    };
  });
}

/** Source pressure notification, deduplicated per source per hour. */
export async function emitSourcePressure(sourceId: string, detail: string): Promise<boolean> {
  return withOperatorTransaction((client) => emitSourcePressureInTransaction(client, sourceId, detail));
}
