import { describe, expect, it, vi } from "vitest";
import type { FreeTierPolicyRecord, QuotaPeriodRecord } from "./types";
import { detectCommitmentAndWaitlist, detectConsumption, projectExhaustion, thresholdsFrom } from "./events";

const policy: FreeTierPolicyRecord = {
  id: "default",
  default_grant: 100,
  commitment_ceiling: 1000,
  hard_monthly_cap: 5000,
  committed_amount: 0,
  admissions_enabled: true,
  included_traffic_enabled: true,
  warning_thresholds: { commitment_pct: [80, 90], slots_remaining: [10, 5], consumption_pct: [80, 95, 100] },
  next_period_changes: [],
  version: 1,
  updated_by: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const period: QuotaPeriodRecord = {
  id: "2026-01",
  period_start: "2026-01-01T00:00:00.000Z",
  period_end: "2026-02-01T00:00:00.000Z",
  hard_cap: 5000,
  reserved: 0,
  consumed: 0,
  status: "open",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function fakeClient(insertedKeys: Set<string>, policyRow?: FreeTierPolicyRecord, insertedEvents: Array<{ eventType: string; periodId: unknown }> = []) {
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM free_tier_policy WHERE id = 'default'")) {
        return { rows: policyRow ? [policyRow] : [] };
      }
      if (sql.includes("FROM free_tier_enrollments WHERE status = 'waitlisted'")) {
        return { rows: [{ count: "3" }] };
      }
      if (sql.includes("INSERT INTO quota_events")) {
        const key = String(params[1]);
        insertedEvents.push({ eventType: String(params[2]), periodId: params[5] });
        if (insertedKeys.has(key)) return { rows: [] };
        insertedKeys.add(key);
        return { rows: [{ id: "event-1" }] };
      }
      return { rows: [] };
    }),
  } as never;
}

describe("quota threshold events", () => {
  it("normalizes thresholds from policy warning config", () => {
    const thresholds = thresholdsFrom({ warning_thresholds: { commitment_pct: [90, 80], slots_remaining: [5, 10], consumption_pct: "x" } });
    expect(thresholds.commitmentPct).toEqual([80, 90]);
    expect(thresholds.slotsRemaining).toEqual([5, 10]);
    expect(thresholds.consumptionPct).toEqual([]);
  });

  it("emits one event per threshold per policy version and deduplicates repeats", async () => {
    const inserted = new Set<string>();
    const insertedEvents: Array<{ eventType: string; periodId: unknown }> = [];
    const client = fakeClient(inserted, undefined, insertedEvents);
    const nearFull = { ...policy, committed_amount: 850, version: 4 };

    const first = await detectCommitmentAndWaitlist(client, nearFull);
    const second = await detectCommitmentAndWaitlist(client, nearFull);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0); // same threshold + version: deduplicated

    // Policy-scoped events must not reference a quota_periods row: the FK is
    // satisfied with NULL or the enclosing admission transaction rolls back.
    for (const event of insertedEvents) {
      expect(event.periodId).toBeNull();
    }

    // Crossing a higher threshold creates a new event.
    const higher = { ...nearFull, committed_amount: 950, version: 4 };
    const crossed = await detectCommitmentAndWaitlist(client, higher);
    expect(crossed).toBeGreaterThan(0);
    // A new policy version re-opens the threshold events.
    const bumped = { ...nearFull, version: 5 };
    const reOpened = await detectCommitmentAndWaitlist(client, bumped);
    expect(reOpened).toBeGreaterThan(0);
  });

  it("emits consumption thresholds and hard-cap events per period", async () => {
    const inserted = new Set<string>();
    const insertedEvents: Array<{ eventType: string; periodId: unknown }> = [];
    const client = fakeClient(inserted, policy, insertedEvents);
    const busy = { ...period, consumed: 4000, reserved: 800 };

    const first = await detectConsumption(client, busy);
    expect(first).toBeGreaterThan(0); // 96% >= 80/95 thresholds
    expect(await detectConsumption(client, busy)).toBe(0); // deduplicated
    expect(insertedEvents.every((event) => event.periodId === "2026-01")).toBe(true);

    const capped = { ...busy, consumed: 5000, reserved: 0 };
    expect(await detectConsumption(client, capped)).toBeGreaterThan(0); // hard cap + 100%
  });

  it("projects early exhaustion before the period ends", () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const current = { ...period, period_start: start.toISOString(), period_end: end.toISOString() };

    // Consumption at a rate that exhausts well before month end -> projected.
    const projected = projectExhaustion({ ...current, consumed: Math.floor(current.hard_cap / 2) }, 3);
    expect(projected).not.toBeNull();
    expect(projected!.getTime()).toBeLessThan(end.getTime());

    // Consumption too slow to exhaust: no projection.
    expect(projectExhaustion({ ...current, consumed: 1 }, 3)).toBeNull();
    // Already exhausted: no projection.
    expect(projectExhaustion({ ...current, consumed: 5000 }, 3)).toBeNull();
    // No consumption: no projection.
    expect(projectExhaustion({ ...current, consumed: 0 }, 3)).toBeNull();
  });
});
