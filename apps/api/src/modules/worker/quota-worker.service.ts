import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { RateLimitService } from "../../core/rate-limit/rate-limit.service";
import { QuotaService } from "../quota/application/quota.service";

const PERIOD_INTERVAL_MS = 60 * 60 * 1000;
const WAITLIST_INTERVAL_MS = 5 * 60 * 1000;
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

type JobName = "period" | "waitlist" | "reconcile" | "rateLimitCleanup";

@Injectable()
export class QuotaWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QuotaWorkerService.name);
  private readonly running = new Set<JobName>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly quota: QuotaService, private readonly rateLimits: RateLimitService) {}

  async onModuleInit(): Promise<void> {
    await this.run("period", () => this.quota.openNextPeriod());
    this.timers = [
      setInterval(() => { void this.run("period", () => this.quota.openNextPeriod()); }, PERIOD_INTERVAL_MS),
      setInterval(() => { void this.run("waitlist", () => this.quota.processWaitlist()); }, WAITLIST_INTERVAL_MS),
      setInterval(() => { void this.run("reconcile", () => this.quota.reconcileExpiredReservations()); }, RECONCILE_INTERVAL_MS),
      setInterval(() => { void this.run("rateLimitCleanup", () => this.rateLimits.purgeExpired()); }, RATE_LIMIT_CLEANUP_INTERVAL_MS),
    ];
    this.logger.log("Quota period, waitlist, and reservation-reconciliation jobs scheduled");
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private async run<T>(name: JobName, task: () => Promise<T>): Promise<void> {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await task();
    } catch (error) {
      this.logger.error(`${name} quota job failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running.delete(name);
    }
  }
}
