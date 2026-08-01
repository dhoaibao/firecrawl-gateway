/** UTC calendar-month math for quota periods. All boundaries are UTC. */

export interface PeriodRange {
  id: string;
  start: Date;
  end: Date;
}

/** 'YYYY-MM' in UTC for the month containing the given date. */
export function periodIdFor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** UTC midnight on the first day of the month containing the given date. */
export function periodStartFor(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** UTC midnight on the first day of the following month (exclusive end). */
export function periodEndFor(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

export function currentPeriodRange(now: Date): PeriodRange {
  return { id: periodIdFor(now), start: periodStartFor(now), end: periodEndFor(now) };
}

/** The period immediately following the one containing the given date. */
export function nextPeriodRange(date: Date): PeriodRange {
  const start = periodEndFor(date);
  return { id: periodIdFor(start), start, end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
}

export function periodIdOf(isoStart: string): string {
  return periodIdFor(new Date(isoStart));
}
