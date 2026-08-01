export type EnrollmentStatus = "waitlisted" | "enrolled" | "revoked";
export type EntitlementStatus = "active" | "suspended" | "revoked" | "closed";
export type PeriodStatus = "open" | "paused" | "closed";
export type ReservationStatus = "reserved" | "consumed" | "released";

/** Stable machine-readable data-plane error codes for quota rejections. */
export type QuotaErrorCode =
  | "quota_exhausted" // account allowance exhausted for the period
  | "quota_hard_cap" // platform hard cap reached
  | "quota_paused" // grants/included traffic paused or period not open
  | "no_entitlement"; // waitlisted or no included entitlement

export interface QuotaRejection {
  code: QuotaErrorCode;
  message: string;
  statusCode: number;
}

export function quotaRejection(code: QuotaErrorCode, message: string, statusCode: number): QuotaRejection {
  return { code, message, statusCode };
}

export interface QuotaReservation {
  /** The actual usage_reservations row id (server-owned, account/period scoped). */
  reservationId: string;
  reserved: boolean;
  /** Account entitlement limit for the current period (metadata header). */
  limit: number;
  /** Remaining allowance after this reservation (metadata header). */
  remaining: number;
  /** ISO timestamp of period end (metadata header). */
  resetAt: string;
  periodId: string;
  entitlementId: string;
}

export interface FreeTierPolicyRecord {
  id: string;
  default_grant: number;
  commitment_ceiling: number;
  hard_monthly_cap: number;
  committed_amount: number;
  admissions_enabled: boolean;
  included_traffic_enabled: boolean;
  warning_thresholds: Record<string, unknown>;
  next_period_changes: Array<Record<string, unknown>>;
  version: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FreeTierEnrollmentRecord {
  account_id: string;
  status: EnrollmentStatus;
  grant_amount: number;
  admitted_at: string | null;
  waitlisted_at: string | null;
  revoked_at: string | null;
  operator_reason: string | null;
  operator_actor: string | null;
  skipped_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuotaPeriodRecord {
  id: string;
  period_start: string;
  period_end: string;
  hard_cap: number;
  reserved: number;
  consumed: number;
  status: PeriodStatus;
  created_at: string;
  updated_at: string;
}

export interface AccountEntitlementRecord {
  id: string;
  account_id: string;
  period_id: string;
  allocated: number;
  reserved: number;
  consumed: number;
  status: EntitlementStatus;
  enrollment_snapshot: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UsageReservationRecord {
  id: string;
  account_id: string;
  period_id: string;
  entitlement_id: string;
  status: ReservationStatus;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface UsageEventRecord {
  id: string;
  request_id: string;
  account_id: string;
  period_id: string | null;
  kind: "charge" | "adjustment";
  amount: number;
  actor: string | null;
  reason: string | null;
  created_at: string;
}

export interface QuotaEventRecord {
  id: string;
  dedup_key: string;
  event_type: string;
  severity: "info" | "warn" | "critical";
  account_id: string | null;
  period_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export type AdmissionOutcome =
  | { status: "enrolled"; enrollment: FreeTierEnrollmentRecord; entitlement: AccountEntitlementRecord | null }
  | { status: "waitlisted"; enrollment: FreeTierEnrollmentRecord }
  | { status: "revoked"; enrollment: FreeTierEnrollmentRecord };

export interface WaitlistProcessingResult {
  admitted: number;
  claimed: number;
  stoppedReason: "capacity" | "paused" | "empty" | "unfit";
  remaining: number;
}

export interface PolicyUpdateInput {
  defaultGrant?: number;
  commitmentCeiling?: number;
  hardMonthlyCap?: number;
  admissionsEnabled?: boolean;
  includedTrafficEnabled?: boolean;
  warningThresholds?: Record<string, unknown>;
  actor: string;
  reason?: string;
}

export interface PeriodChangeInput {
  periodId: string;
  defaultGrant?: number;
  commitmentCeiling?: number;
  hardMonthlyCap?: number;
}

export interface ReconciliationReport {
  generatedAt: string;
  periodId: string;
  checks: Array<{ name: string; status: "ok" | "mismatch"; details: string }>;
  mismatches: number;
}
