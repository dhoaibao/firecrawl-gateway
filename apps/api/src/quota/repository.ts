import type { PoolClient } from "pg";
import type {
  AccountEntitlementRecord,
  EnrollmentStatus,
  FreeTierEnrollmentRecord,
  FreeTierPolicyRecord,
  QuotaEventRecord,
  QuotaPeriodRecord,
  UsageEventRecord,
  UsageReservationRecord,
} from "./types";

/** Policy ------------------------------------------------------------------ */

export async function getPolicy(client: PoolClient): Promise<FreeTierPolicyRecord | null> {
  const result = await client.query<FreeTierPolicyRecord>("SELECT * FROM free_tier_policy WHERE id = 'default'");
  return result.rows[0] ?? null;
}

export async function lockPolicy(client: PoolClient): Promise<FreeTierPolicyRecord | null> {
  const result = await client.query<FreeTierPolicyRecord>(
    "SELECT * FROM free_tier_policy WHERE id = 'default' FOR UPDATE",
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically commit `grant` against the ceiling. Succeeds only when the
 * increment fits and admissions are enabled; serialized by the policy row lock.
 */
export async function incrementCommitment(client: PoolClient, grant: number): Promise<boolean> {
  const result = await client.query(
    `UPDATE free_tier_policy
     SET committed_amount = committed_amount + $1, version = version + 1, updated_at = NOW()
     WHERE id = 'default' AND admissions_enabled
       AND committed_amount + $1 <= commitment_ceiling`,
    [grant],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Release exactly `grant` from the permanent commitment, never below zero. */
export async function decrementCommitment(client: PoolClient, grant: number): Promise<boolean> {
  const result = await client.query(
    `UPDATE free_tier_policy
     SET committed_amount = GREATEST(committed_amount - $1, 0), version = version + 1, updated_at = NOW()
     WHERE id = 'default' AND committed_amount >= $1`,
    [grant],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Enrollments -------------------------------------------------------------- */

export async function getEnrollment(client: PoolClient, accountId: string): Promise<FreeTierEnrollmentRecord | null> {
  const result = await client.query<FreeTierEnrollmentRecord>(
    "SELECT * FROM free_tier_enrollments WHERE account_id = $1",
    [accountId],
  );
  return result.rows[0] ?? null;
}

export async function lockEnrollment(client: PoolClient, accountId: string): Promise<FreeTierEnrollmentRecord | null> {
  const result = await client.query<FreeTierEnrollmentRecord>(
    "SELECT * FROM free_tier_enrollments WHERE account_id = $1 FOR UPDATE",
    [accountId],
  );
  return result.rows[0] ?? null;
}

export async function insertEnrollment(
  client: PoolClient,
  accountId: string,
  status: EnrollmentStatus,
  grant: number,
  actor: string | null,
  reason: string | null,
): Promise<FreeTierEnrollmentRecord> {
  const result = await client.query<FreeTierEnrollmentRecord>(
    `INSERT INTO free_tier_enrollments (account_id, status, grant_amount, admitted_at, waitlisted_at, operator_reason, operator_actor)
     VALUES ($1, $2, $3,
             CASE WHEN $2 = 'enrolled' THEN NOW() ELSE NULL END,
             CASE WHEN $2 = 'waitlisted' THEN NOW() ELSE NULL END,
             $4, $5)
     ON CONFLICT (account_id) DO NOTHING
     RETURNING *`,
    [accountId, status, grant, reason ?? actor, actor],
  );
  if (!result.rows[0]) {
    // Idempotent retry: return the existing row without changing counters.
    const existing = await getEnrollment(client, accountId);
    if (!existing) throw new Error("Enrollment insert conflicted without an existing row");
    return existing;
  }
  return result.rows[0];
}

export async function updateEnrollmentStatus(
  client: PoolClient,
  accountId: string,
  status: EnrollmentStatus,
  actor: string,
  reason: string,
): Promise<FreeTierEnrollmentRecord | null> {
  const result = await client.query<FreeTierEnrollmentRecord>(
    `UPDATE free_tier_enrollments
     SET status = $2, operator_reason = $4, operator_actor = $3,
         admitted_at = CASE WHEN $2 = 'enrolled' THEN COALESCE(admitted_at, NOW()) ELSE admitted_at END,
         waitlisted_at = CASE WHEN $2 = 'waitlisted' THEN COALESCE(waitlisted_at, NOW()) ELSE waitlisted_at END,
         revoked_at = CASE WHEN $2 = 'revoked' THEN NOW() ELSE revoked_at END,
         skipped_at = NULL,
         updated_at = NOW()
     WHERE account_id = $1 RETURNING *`,
    [accountId, status, actor, reason],
  );
  return result.rows[0] ?? null;
}

export async function markWaitlistSkipped(
  client: PoolClient,
  accountId: string,
  actor: string,
  reason: string,
): Promise<FreeTierEnrollmentRecord | null> {
  const result = await client.query<FreeTierEnrollmentRecord>(
    `UPDATE free_tier_enrollments
     SET operator_reason = $3, operator_actor = $2, skipped_at = NOW(), updated_at = NOW()
     WHERE account_id = $1 AND status = 'waitlisted' RETURNING *`,
    [accountId, actor, reason],
  );
  return result.rows[0] ?? null;
}

/** Periods ------------------------------------------------------------------ */

export async function getPeriod(client: PoolClient, periodId: string): Promise<QuotaPeriodRecord | null> {
  const result = await client.query<QuotaPeriodRecord>("SELECT * FROM quota_periods WHERE id = $1", [periodId]);
  return result.rows[0] ?? null;
}

/** Lock the open current-period row so hard-cap validation serializes with reservations. */
export async function lockOpenPeriod(client: PoolClient): Promise<QuotaPeriodRecord | null> {
  const result = await client.query<QuotaPeriodRecord>(
    `SELECT * FROM quota_periods
     WHERE status = 'open' AND period_start <= NOW() AND period_end > NOW()
     LIMIT 1
     FOR UPDATE`,
  );
  return result.rows[0] ?? null;
}

export async function upsertPeriod(
  client: PoolClient,
  periodId: string,
  start: Date,
  end: Date,
  hardCap: number,
): Promise<QuotaPeriodRecord> {
  const result = await client.query<QuotaPeriodRecord>(
    `INSERT INTO quota_periods (id, period_start, period_end, hard_cap)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [periodId, start.toISOString(), end.toISOString(), hardCap],
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await getPeriod(client, periodId);
  if (!existing) throw new Error("Period upsert conflicted without an existing row");
  return existing;
}

export async function setPeriodStatus(
  client: PoolClient,
  periodId: string,
  status: QuotaPeriodRecord["status"],
): Promise<QuotaPeriodRecord | null> {
  const result = await client.query<QuotaPeriodRecord>(
    "UPDATE quota_periods SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
    [periodId, status],
  );
  return result.rows[0] ?? null;
}

/** Entitlements ------------------------------------------------------------- */

export async function getEntitlement(
  client: PoolClient,
  accountId: string,
  periodId: string,
): Promise<AccountEntitlementRecord | null> {
  const result = await client.query<AccountEntitlementRecord>(
    "SELECT * FROM account_entitlements WHERE account_id = $1 AND period_id = $2",
    [accountId, periodId],
  );
  return result.rows[0] ?? null;
}

export async function insertEntitlement(
  client: PoolClient,
  accountId: string,
  periodId: string,
  allocated: number,
  snapshot: Record<string, unknown>,
): Promise<AccountEntitlementRecord> {
  const result = await client.query<AccountEntitlementRecord>(
    `INSERT INTO account_entitlements (id, account_id, period_id, allocated, status, enrollment_snapshot)
     VALUES ($1, $2, $3, $4, 'active', $5::jsonb)
     ON CONFLICT (account_id, period_id) DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), accountId, periodId, allocated, JSON.stringify(snapshot)],
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await getEntitlement(client, accountId, periodId);
  if (!existing) throw new Error("Entitlement insert conflicted without an existing row");
  return existing;
}

export async function setEntitlementStatusForAccount(
  client: PoolClient,
  accountId: string,
  status: AccountEntitlementRecord["status"],
  periodId?: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE account_entitlements SET status = $2, updated_at = NOW()
     WHERE account_id = $1 AND status IN ('active', 'suspended') AND ($3::text IS NULL OR period_id = $3)`,
    [accountId, status, periodId ?? null],
  );
  return result.rowCount ?? 0;
}

/**
 * Idempotently issue current-period entitlements to every enrolled, verified,
 * active account. Suspended/blocked/unverified accounts are skipped; a revoked
 * enrollment never receives one. Allocated mirrors the committed per-account
 * grant. Returns the number of rows inserted.
 */
export async function issueEntitlementsForPeriod(client: PoolClient, periodId: string): Promise<number> {
  const result = await client.query(
    `INSERT INTO account_entitlements (id, account_id, period_id, allocated, status, enrollment_snapshot)
     SELECT md5(random()::text || clock_timestamp()::text), e.account_id, $1, e.grant_amount, 'active',
            jsonb_build_object('enrollment_status', e.status, 'grant_amount', e.grant_amount,
                               'initial_allocated', e.grant_amount)
     FROM free_tier_enrollments e
     INNER JOIN accounts a ON a.id = e.account_id
     INNER JOIN account_memberships m ON m.account_id = e.account_id AND m.role = 'owner'
     INNER JOIN users u ON u.id = m.user_id
     WHERE e.status = 'enrolled'
       AND a.status = 'active'
       AND u.status = 'active'
       AND u.email_verified_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM account_entitlements ae
         WHERE ae.account_id = e.account_id AND ae.period_id = $1
       )
     ON CONFLICT (account_id, period_id) DO NOTHING`,
    [periodId],
  );
  return result.rowCount ?? 0;
}

/** Reservation counters ----------------------------------------------------- */

/**
 * Atomically reserve one account request. Succeeds only when the entitlement
 * is active and has headroom; the row lock serializes concurrent requests.
 */
export async function reserveAccountSlot(
  client: PoolClient,
  accountId: string,
  periodId: string,
): Promise<AccountEntitlementRecord | null> {
  const result = await client.query<AccountEntitlementRecord>(
    `UPDATE account_entitlements
     SET reserved = reserved + 1, updated_at = NOW()
     WHERE account_id = $1 AND period_id = $2 AND status = 'active'
       AND consumed + reserved < allocated
     RETURNING *`,
    [accountId, periodId],
  );
  return result.rows[0] ?? null;
}

/** Atomically reserve one platform request while the period is open with headroom. */
export async function reservePeriodSlot(client: PoolClient, periodId: string): Promise<QuotaPeriodRecord | null> {
  const result = await client.query<QuotaPeriodRecord>(
    `UPDATE quota_periods
     SET reserved = reserved + 1, updated_at = NOW()
     WHERE id = $1 AND status = 'open'
       AND consumed + reserved < hard_cap
     RETURNING *`,
    [periodId],
  );
  return result.rows[0] ?? null;
}

/** Reservations ------------------------------------------------------------- */

export async function insertReservation(
  client: PoolClient,
  input: { id: string; accountId: string; periodId: string; entitlementId: string; expiresAt: Date },
): Promise<UsageReservationRecord | null> {
  const result = await client.query<UsageReservationRecord>(
    `INSERT INTO usage_reservations (id, account_id, period_id, entitlement_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [input.id, input.accountId, input.periodId, input.entitlementId, input.expiresAt.toISOString()],
  );
  return result.rows[0] ?? null;
}

export async function getReservation(client: PoolClient, id: string): Promise<UsageReservationRecord | null> {
  const result = await client.query<UsageReservationRecord>(
    "SELECT * FROM usage_reservations WHERE id = $1",
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Lock a reservation row for ownership/idempotency decisions. Blocks until a
 * concurrent writer commits so duplicate retries serialize on the row.
 */
export async function lockReservation(client: PoolClient, id: string): Promise<UsageReservationRecord | null> {
  const result = await client.query<UsageReservationRecord>(
    "SELECT * FROM usage_reservations WHERE id = $1 FOR UPDATE",
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Re-arm a released reservation (verification retry with the same request id).
 * Caller must re-bump the counters in the same transaction.
 */
export async function rearmReservation(
  client: PoolClient,
  id: string,
  expiresAt: Date,
): Promise<UsageReservationRecord | null> {
  const result = await client.query<UsageReservationRecord>(
    `UPDATE usage_reservations SET status = 'reserved', expires_at = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'released' RETURNING *`,
    [id, expiresAt.toISOString()],
  );
  return result.rows[0] ?? null;
}

/** Charge exactly once: mark consumed and append the immutable ledger row. */
export async function finalizeReservation(
  client: PoolClient,
  requestId: string,
  reason: string,
): Promise<UsageReservationRecord | null> {
  const result = await client.query<UsageReservationRecord>(
    `WITH finalized AS (
       UPDATE usage_reservations SET status = 'consumed', updated_at = NOW()
       WHERE id = $1 AND status = 'reserved'
       RETURNING *
     )
     SELECT f.id, f.account_id, f.period_id, f.entitlement_id, f.status, f.expires_at, f.created_at, f.updated_at
     FROM finalized f
     LEFT JOIN usage_events ev ON ev.request_id = $1
     WHERE ev.request_id IS NULL`,
    [requestId],
  );
  const reservation = result.rows[0] ?? null;
  if (reservation) {
    await client.query(
      `INSERT INTO usage_events (id, request_id, account_id, period_id, kind, amount, reason)
       VALUES ($1, $2, $3, $4, 'charge', 1, $5)`,
      [crypto.randomUUID(), requestId, reservation.account_id, reservation.period_id, reason],
    );
    await client.query(
      `UPDATE account_entitlements
       SET consumed = consumed + 1, reserved = GREATEST(reserved - 1, 0), updated_at = NOW()
       WHERE id = $1 AND reserved > 0`,
      [reservation.entitlement_id],
    );
    await client.query(
      `UPDATE quota_periods
       SET consumed = consumed + 1, reserved = GREATEST(reserved - 1, 0), updated_at = NOW()
       WHERE id = $1 AND reserved > 0`,
      [reservation.period_id],
    );
  }
  return reservation;
}

/** Release a reservation that never reached an operator upstream. */
export async function releaseReservation(
  client: PoolClient,
  requestId: string,
): Promise<UsageReservationRecord | null> {
  const result = await client.query<UsageReservationRecord>(
    `UPDATE usage_reservations SET status = 'released', updated_at = NOW()
     WHERE id = $1 AND status = 'reserved' RETURNING *`,
    [requestId],
  );
  const reservation = result.rows[0] ?? null;
  if (reservation) {
    await client.query(
      `UPDATE account_entitlements SET reserved = GREATEST(reserved - 1, 0), updated_at = NOW()
       WHERE id = $1 AND reserved > 0`,
      [reservation.entitlement_id],
    );
    await client.query(
      `UPDATE quota_periods SET reserved = GREATEST(reserved - 1, 0), updated_at = NOW()
       WHERE id = $1 AND reserved > 0`,
      [reservation.period_id],
    );
  }
  return reservation;
}

/** Claim expired in-flight reservations; charge conservatively. */
export async function listExpiredReservations(client: PoolClient, limit: number): Promise<UsageReservationRecord[]> {
  const result = await client.query<UsageReservationRecord>(
    `SELECT * FROM usage_reservations
     WHERE status = 'reserved' AND expires_at < NOW()
     ORDER BY expires_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows;
}

/** Ledger ------------------------------------------------------------------- */

export async function insertAdjustmentEvent(
  client: PoolClient,
  input: { requestId: string; accountId: string; periodId: string | null; amount: number; actor: string; reason: string },
): Promise<UsageEventRecord> {
  const result = await client.query<UsageEventRecord>(
    `INSERT INTO usage_events (id, request_id, account_id, period_id, kind, amount, actor, reason)
     VALUES ($1, $2, $3, $4, 'adjustment', $5, $6, $7)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.requestId,
      input.accountId,
      input.periodId,
      input.amount,
      input.actor,
      input.reason,
    ],
  );
  if (result.rows[0]) return result.rows[0];
  throw new Error(`Adjustment event ${input.requestId} already exists`);
}

/** Waitlist ----------------------------------------------------------------- */

export interface WaitlistCandidate extends FreeTierEnrollmentRecord {
  account_status: string;
  email_verified_at: string | null;
}

/** Claim the oldest eligible waitlist rows FIFO, skipping operator-skipped rows. */
export async function claimWaitlistCandidates(client: PoolClient, batch: number): Promise<WaitlistCandidate[]> {
  const result = await client.query<WaitlistCandidate>(
    `SELECT e.*, a.status AS account_status, u.email_verified_at
     FROM free_tier_enrollments e
     INNER JOIN accounts a ON a.id = e.account_id
     INNER JOIN account_memberships m ON m.account_id = e.account_id AND m.role = 'owner'
     INNER JOIN users u ON u.id = m.user_id
     WHERE e.status = 'waitlisted' AND e.skipped_at IS NULL
       AND a.status = 'active' AND u.status = 'active' AND u.email_verified_at IS NOT NULL
     ORDER BY e.waitlisted_at ASC, e.account_id ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batch],
  );
  return result.rows;
}

export async function countWaitlist(client: PoolClient): Promise<number> {
  const result = await client.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM free_tier_enrollments WHERE status = 'waitlisted' AND skipped_at IS NULL",
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Quota events ------------------------------------------------------------- */

export async function insertQuotaEvent(
  client: PoolClient,
  input: {
    dedupKey: string;
    eventType: string;
    severity: "info" | "warn" | "critical";
    accountId?: string;
    periodId?: string;
    payload?: Record<string, unknown>;
  },
): Promise<QuotaEventRecord | null> {
  const result = await client.query<QuotaEventRecord>(
    `INSERT INTO quota_events (id, dedup_key, event_type, severity, account_id, period_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING *`,
    [
      crypto.randomUUID(),
      input.dedupKey,
      input.eventType,
      input.severity,
      input.accountId ?? null,
      input.periodId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return result.rows[0] ?? null;
}
