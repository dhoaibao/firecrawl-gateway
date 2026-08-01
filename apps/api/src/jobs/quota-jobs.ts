import { rootLogger } from "../logger";
import { openNextPeriod, processWaitlist, reconcileExpiredReservations } from "../quota/service";

const logger = rootLogger.child({ module: "quota-jobs" });

const PERIOD_INTERVAL_MS = 60 * 60 * 1000;
const WAITLIST_INTERVAL_MS = 5 * 60 * 1000;
const RESERVATION_RECONCILE_INTERVAL_MS = 2 * 60 * 1000;

interface RunningFlags {
  period: boolean;
  waitlist: boolean;
  reconcile: boolean;
}

export function startQuotaJobs(): () => void {
  const running: RunningFlags = { period: false, waitlist: false, reconcile: false };

  const run = async (name: keyof RunningFlags, task: () => Promise<unknown>): Promise<void> => {
    if (running[name]) return;
    running[name] = true;
    try {
      await task();
    } catch (error) {
      logger.error({ err: error, job: name }, "Quota background job failed");
    } finally {
      running[name] = false;
    }
  };

  // Monthly periods and entitlements are created idempotently; the lazy API
  // recovery path means correctness never depends on this schedule.
  const periodTimer = setInterval(() => {
    void run("period", () => openNextPeriod().then(({ period, issued }) => {
      if (issued > 0) logger.info({ period: period.id, issued }, "Opened quota period and issued entitlements");
    }));
  }, PERIOD_INTERVAL_MS);

  const waitlistTimer = setInterval(() => {
    void run("waitlist", () => processWaitlist().then((result) => {
      if (result.admitted > 0) logger.info({ admitted: result.admitted }, "Admitted accounts from the waitlist");
    }));
  }, WAITLIST_INTERVAL_MS);

  const reconcileTimer = setInterval(() => {
    void run("reconcile", () => reconcileExpiredReservations().then((charged) => {
      if (charged > 0) logger.warn({ charged }, "Charged expired in-flight quota reservations");
    }));
  }, RESERVATION_RECONCILE_INTERVAL_MS);

  logger.info("Quota period, waitlist, and reservation-reconciliation jobs scheduled");

  return () => {
    clearInterval(periodTimer);
    clearInterval(waitlistTimer);
    clearInterval(reconcileTimer);
  };
}
