import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SettingsService } from "../settings/settings.service";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { encryptSettingValue } from "../common/crypto";
import { CreditRoutingService, parseCreditKeys } from "../credits/credit-routing.service";

@Injectable()
export class CronService {
  // Fixed retention window (user decision): audit entries older than this are
  // pruned. AUDIT_RETENTION_DAYS is the single greppable source of the cutoff.
  private static readonly AUDIT_RETENTION_DAYS = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly credits: CreditRoutingService,
  ) {}

  isAuthorized(authorization: string | undefined): boolean {
    return Boolean(this.config.cronSecret) && authorization === `Bearer ${this.config.cronSecret}`;
  }

  async runMaintenance(): Promise<{
    revoked: number;
    rateLimitsDeleted: number;
    auditLogsDeleted: number;
    creditUsageRefreshed: number;
  }> {
    const creditUsageRefreshed = await this.refreshCreditUsage();
    const revoked = await this.revokeInactiveKeys();
    const rateLimitsDeleted = await this.deleteExpiredRateLimits();
    const auditLogsDeleted = await this.pruneOldAuditLogs();
    return { revoked, rateLimitsDeleted, auditLogsDeleted, creditUsageRefreshed };
  }

  private async refreshCreditUsage(): Promise<number> {
    const record = await this.settings.getSetting("firecrawl_api_keys");
    if (!record?.value) return 0;
    try {
      const parsed = parseCreditKeys(record.value, this.config.firecrawlKeysEncryptionKey);
      if (!parsed.encrypted)
        await this.settings.replaceSettingIfUnchanged(
          record.key,
          record.value,
          encryptSettingValue(record.value, this.config.firecrawlKeysEncryptionKey),
        );
      const details = await this.credits.refreshCreditUsageForKeys(parsed.keys);
      return details.filter((item) => !item.error && item.remainingCredits !== null).length;
    } catch {
      return 0;
    }
  }

  /**
   * Batch sizes are chosen against API_REQUEST_TIMEOUT_MS (120s by default):
   * a single indexed DELETE of 5,000 rows typically completes well under a
   * second, so even the full bound of 20 batches per table per run stays far
   * inside the request budget while keeping individual lock windows short.
   *
   * The iteration bound means one run deletes at most
   * BATCH_SIZE * MAX_PRUNE_BATCHES rows per table. The audit_logs table has
   * never been pruned, so the first production runs may face a large backlog;
   * draining it may take several daily runs. That is intentional: short batches
   * avoid holding locks long enough to turn a cleanup into an outage.
   */
  private static readonly PRUNE_BATCH_SIZE = 5_000;
  private static readonly MAX_PRUNE_BATCHES = 20;

  private async pruneBatched(runBatch: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < CronService.MAX_PRUNE_BATCHES; batch += 1) {
      const deleted = await runBatch();
      total += deleted;
      // A short batch means the deletable set is drained.
      if (deleted < CronService.PRUNE_BATCH_SIZE) break;
    }
    return total;
  }

  private async deleteExpiredRateLimits(): Promise<number> {
    return this.pruneBatched(async () => {
      const deleted = await this.prisma.$queryRaw<Array<{ key: string }>>(Prisma.sql`
        DELETE FROM rate_limits
        WHERE key IN (
          SELECT key
          FROM rate_limits
          WHERE reset_at < NOW()
          ORDER BY reset_at ASC
          LIMIT ${CronService.PRUNE_BATCH_SIZE}
        )
        RETURNING key
      `);
      return deleted.length;
    });
  }

  private async pruneOldAuditLogs(): Promise<number> {
    // Cutoff direction matters: created_at < cutoff selects ONLY rows older
    // than the retention window. Rows at or after the cutoff are retained.
    // An inverted comparison here would permanently delete live history.
    const cutoff = new Date(Date.now() - CronService.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    return this.pruneBatched(async () => {
      // Table/column names verified against schema.prisma (@@map audit_logs,
      // @map created_at); Prisma deleteMany has no LIMIT, hence raw SQL with
      // a subselect mirroring the rate-limit cleanup above.
      const deleted = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        DELETE FROM audit_logs
        WHERE id IN (
          SELECT id
          FROM audit_logs
          WHERE created_at < ${cutoff}
          ORDER BY created_at ASC
          LIMIT ${CronService.PRUNE_BATCH_SIZE}
        )
        RETURNING id
      `);
      return deleted.length;
    });
  }

  private async revokeInactiveKeys(): Promise<number> {
    const record = await this.settings.getSetting("api_key_inactivity_revoke_days");
    const days = Number(record?.value);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const threshold = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return (
      await this.prisma.apiKey.updateMany({
        where: {
          revoked: false,
          createdAt: { lt: threshold },
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: threshold } }],
        },
        data: { revoked: true },
      })
    ).count;
  }
}
