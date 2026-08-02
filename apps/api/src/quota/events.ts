import type { DatabaseClient } from "../db";
import * as repo from "./repository";
import type { FreeTierPolicyRecord, QuotaPeriodRecord } from "./types";

/**
 * Threshold/exhaustion detection with deduplicated notifications.
 * Phase 7 renders and delivers these; Phase 5 owns detection and dedup keys.
 * Repeated requests above one threshold produce exactly one event per
 * policy version or period; crossing a higher threshold creates a new one.
 */

export interface ThresholdConfig {
  commitmentPct: number[];
  slotsRemaining: number[];
  consumptionPct: number[];
  waitlistBuckets: number[];
  /** Projected-exhaustion lead time in days before period end. */
  projectedLeadDays: number;
}

export function thresholdsFrom(policy: Pick<FreeTierPolicyRecord, "warning_thresholds">): ThresholdConfig {
  const raw = policy.warning_thresholds ?? {};
  const asNumbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b) : [];
  const lead = raw.projected_exhaustion_lead_days;
  return {
    commitmentPct: asNumbers(raw.commitment_pct),
    slotsRemaining: asNumbers(raw.slots_remaining),
    consumptionPct: asNumbers(raw.consumption_pct),
    waitlistBuckets: asNumbers(raw.waitlist_buckets).length > 0 ? asNumbers(raw.waitlist_buckets) : [25, 50, 100, 250, 500, 1000],
    projectedLeadDays: typeof lead === "number" && lead > 0 ? lead : 3,
  };
}

/** Emit commitment-capacity, slots-remaining, and waitlist-growth events. */
export async function detectCommitmentAndWaitlist(
  client: DatabaseClient,
  policy: FreeTierPolicyRecord,
): Promise<number> {
  const thresholds = thresholdsFrom(policy);
  let emitted = 0;

  if (policy.commitment_ceiling > 0) {
    const pct = Math.floor((policy.committed_amount / policy.commitment_ceiling) * 100);
    for (const threshold of thresholds.commitmentPct) {
      if (pct >= threshold) {
        emitted += await emit(
          client,
          `commitment_threshold:${threshold}:v${policy.version}`,
          "commitment_threshold",
          threshold >= 90 ? "critical" : "warn",
          undefined,
          // Policy-scoped events have no quota_periods row; the FK is satisfied
          // with NULL and the period is identified in the payload only.
          undefined,
          { committed: policy.committed_amount, ceiling: policy.commitment_ceiling, pct, threshold },
        );
      }
    }
    for (const remaining of thresholds.slotsRemaining) {
      const slots = Math.max(policy.commitment_ceiling - policy.committed_amount, 0);
      if (slots <= remaining) {
        emitted += await emit(
          client,
          `slots_remaining:${remaining}:v${policy.version}`,
          "slots_remaining",
          remaining <= 0 ? "critical" : "warn",
          undefined,
          undefined,
          { committed: policy.committed_amount, ceiling: policy.commitment_ceiling, slots, threshold: remaining },
        );
      }
    }
  }

  const waitlist = await repo.countWaitlist(client);
  for (const bucket of thresholds.waitlistBuckets) {
    if (waitlist >= bucket) {
      emitted += await emit(
        client,
        `waitlist_growth:${bucket}`,
        "waitlist_growth",
        "warn",
        undefined,
        undefined,
        { waitlist, bucket },
      );
    }
  }
  return emitted;
}

/** Emit consumption-threshold, hard-cap, and projected-exhaustion events. */
export async function detectConsumption(client: DatabaseClient, period: QuotaPeriodRecord): Promise<number> {
  const policy = await repo.getPolicy(client);
  if (!policy) return 0;
  const thresholds = thresholdsFrom(policy);
  let emitted = 0;

  if (period.hard_cap > 0) {
    const pct = Math.floor(((period.consumed + period.reserved) / period.hard_cap) * 100);
    for (const threshold of thresholds.consumptionPct) {
      if (pct >= threshold) {
        emitted += await emit(
          client,
          `consumption_threshold:${threshold}:${period.id}`,
          "consumption_threshold",
          threshold >= 100 ? "critical" : threshold >= 90 ? "warn" : "info",
          undefined,
          period.id,
          { consumed: period.consumed, reserved: period.reserved, hardCap: period.hard_cap, pct, threshold },
        );
      }
    }

    if (period.consumed + period.reserved >= period.hard_cap) {
      emitted += await emit(
        client,
        `hard_cap_reached:${period.id}`,
        "hard_cap_reached",
        "critical",
        undefined,
        period.id,
        { consumed: period.consumed, hardCap: period.hard_cap },
      );
    }
  }

  // Projected early exhaustion: linear extrapolation of the consumption rate.
  const projected = projectExhaustion(period, thresholds.projectedLeadDays);
  if (projected) {
    emitted += await emit(
      client,
      `projected_exhaustion:${period.id}:${projected.toISOString().slice(0, 10)}`,
      "projected_exhaustion",
      "warn",
      undefined,
      period.id,
      { projectedAt: projected.toISOString(), consumed: period.consumed, hardCap: period.hard_cap },
    );
  }
  return emitted;
}

export function projectExhaustion(period: QuotaPeriodRecord, leadDays = 3): Date | null {
  const now = Date.now();
  const start = new Date(period.period_start).getTime();
  const end = new Date(period.period_end).getTime();
  if (period.hard_cap <= 0 || period.consumed <= 0) return null;
  if (period.consumed >= period.hard_cap) return null;
  const elapsed = now - start;
  if (elapsed <= 0) return null;
  const ratePerMs = period.consumed / elapsed;
  const projectedMs = start + period.hard_cap / ratePerMs;
  if (!Number.isFinite(projectedMs) || projectedMs >= end) return null;
  const projected = new Date(projectedMs);
  // Emit only when the projection lands with more than the lead time to spare,
  // so a fresh projection is actionable rather than last-minute noise.
  if (projected.getTime() >= end - leadDays * 24 * 60 * 60 * 1000) return null;
  return projected;
}

async function emit(
  client: DatabaseClient,
  dedupKey: string,
  eventType: string,
  severity: "info" | "warn" | "critical",
  accountId: string | undefined,
  periodId: string | undefined,
  payload: Record<string, unknown>,
): Promise<number> {
  const inserted = await repo.insertQuotaEvent(client, { dedupKey, eventType, severity, accountId, periodId, payload });
  return inserted ? 1 : 0;
}

/** Source budget/concurrency/health pressure, deduplicated per source per hour. */
export async function emitSourcePressure(
  client: DatabaseClient,
  sourceId: string,
  detail: string,
): Promise<boolean> {
  const hour = new Date().toISOString().slice(0, 13);
  const inserted = await repo.insertQuotaEvent(client, {
    dedupKey: `source_pressure:${sourceId}:${hour}`,
    eventType: "source_pressure",
    severity: "warn",
    payload: { sourceId, detail },
  });
  return Boolean(inserted);
}
