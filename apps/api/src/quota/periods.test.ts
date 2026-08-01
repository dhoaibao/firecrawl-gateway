import { describe, expect, it } from "vitest";
import {
  currentPeriodRange,
  nextPeriodRange,
  periodEndFor,
  periodIdFor,
  periodStartFor,
} from "./periods";

describe("UTC quota period math", () => {
  it("derives the period id and boundaries for a mid-month date", () => {
    const date = new Date("2026-08-15T12:34:56.789Z");
    expect(periodIdFor(date)).toBe("2026-08");
    expect(periodStartFor(date).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(periodEndFor(date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("keeps December inside its month and rolls the year over correctly", () => {
    const date = new Date("2026-12-31T23:59:59.999Z");
    expect(periodIdFor(date)).toBe("2026-12");
    expect(periodStartFor(date).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(periodEndFor(date).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(nextPeriodRange(date).id).toBe("2027-01");
    expect(nextPeriodRange(date).start.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(nextPeriodRange(date).end.toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("handles leap-year February boundaries", () => {
    const leap = new Date("2028-02-29T12:00:00.000Z");
    expect(periodIdFor(leap)).toBe("2028-02");
    expect(periodEndFor(leap).toISOString()).toBe("2028-03-01T00:00:00.000Z");

    const nonLeap = new Date("2027-02-28T12:00:00.000Z");
    expect(periodEndFor(nonLeap).toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("exposes the first instant of the next month as the period end", () => {
    const range = currentPeriodRange(new Date("2026-01-01T00:00:00.000Z"));
    expect(range.id).toBe("2026-01");
    expect(range.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});
