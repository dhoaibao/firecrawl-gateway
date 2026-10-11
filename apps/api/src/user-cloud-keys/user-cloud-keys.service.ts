import { Inject, Injectable, Logger } from "@nestjs/common";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { decryptSettingValue } from "../common/crypto";
import type { CloudKeyEntry } from "../common/types";
import { PrismaService } from "../prisma/prisma.service";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_USERS = 10_000;

/**
 * Reads a portal user's own Firecrawl Cloud API keys (bring your own key) as
 * routing entries. These keys are used only for requests made with that user's
 * virtual keys; they never join the admin's shared pool and the admin's pool is
 * never used for them.
 */
@Injectable()
export class UserCloudKeysService {
  private readonly logger = new Logger(UserCloudKeysService.name);
  private readonly cache = new Map<string, { entries: CloudKeyEntry[]; expiresAt: number }>();
  private readonly warned = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * The user's keys in creation order. A key that cannot be decrypted is skipped
   * (and reported once, by user id only); a database failure rejects so the caller
   * can answer with an error instead of treating the user as having no keys.
   */
  async loadEntries(userId: string): Promise<CloudKeyEntry[]> {
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return [...cached.entries];
    const rows = await this.prisma.userCloudKey.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, keyValue: true, role: true },
    });
    const entries: CloudKeyEntry[] = [];
    for (const row of rows) {
      try {
        const decrypted = decryptSettingValue(row.keyValue, this.config.firecrawlKeysEncryptionKey);
        // User keys are only ever stored encrypted; a plaintext row is not trusted.
        if (!decrypted.encrypted || !decrypted.value) continue;
        entries.push({
          key: decrypted.value,
          role: row.role === "fallback" ? "fallback" : "cloud",
        });
      } catch (error) {
        if (!this.warned.has(row.id)) {
          this.warned.add(row.id);
          // Only the error class and the row id: the message could quote key material.
          this.logger.warn(
            `Could not decrypt a stored user Cloud API key (${(error as Error).name}, id ${row.id}); ` +
              "check FIRECRAWL_KEYS_ENCRYPTION_KEY",
          );
        }
      }
    }
    this.remember(userId, entries);
    return [...entries];
  }

  /** Drops a user's cached keys, e.g. right after they changed them. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private remember(userId: string, entries: CloudKeyEntry[]): void {
    if (this.cache.has(userId)) this.cache.delete(userId);
    else if (this.cache.size >= CACHE_MAX_USERS) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(userId, { entries: [...entries], expiresAt: Date.now() + CACHE_TTL_MS });
  }
}
