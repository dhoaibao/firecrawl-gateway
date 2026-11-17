import { describe, expect, it, vi } from "vitest";
import { CronService } from "./cron.service";
import { encryptSettingValue } from "../common/crypto";

type Sql = { text: string; values: unknown[] };

// Read from the service so the tests track the production constants.
const BATCH_SIZE = (CronService as unknown as { PRUNE_BATCH_SIZE: number }).PRUNE_BATCH_SIZE;
const MAX_BATCHES = (CronService as unknown as { MAX_PRUNE_BATCHES: number }).MAX_PRUNE_BATCHES;

function makeService(queryRaw: ReturnType<typeof vi.fn>) {
  const prisma = { $queryRaw: queryRaw };
  const settings = { getSetting: vi.fn().mockResolvedValue(null) };
  const credits = { refreshCreditUsageForKeys: vi.fn().mockResolvedValue([]) };
  return new CronService(
    prisma as never,
    settings as never,
    {
      cronSecret: "secret",
      firecrawlKeysEncryptionKey:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    } as never,
    credits as never,
    { clearValidationCache: vi.fn() } as never,
  );
}

interface FakeAuditRow {
  id: string;
  created_at: Date;
}

/**
 * Fake for the audit prune: applies the actual comparison operator that the
 * generated SQL uses against the parameter value, so an inverted comparison
 * in the middleware selects the wrong rows and fails the direction test.
 */
function makeAuditFake(rows: FakeAuditRow[]) {
  return async (sql: Sql): Promise<Array<{ id: string }>> => {
    const match = /created_at\s*(<|>|<=|>=)\s*\$1/.exec(sql.text);
    if (!match) throw new Error(`unexpected audit SQL: ${sql.text}`);
    const cutoff = sql.values[0] as Date;
    if (!(cutoff instanceof Date)) throw new Error("cutoff must be a parameterized Date");
    const limit = Number(sql.values[1]);
    const holds = {
      "<": (t: number) => t < cutoff.getTime(),
      ">": (t: number) => t > cutoff.getTime(),
      "<=": (t: number) => t <= cutoff.getTime(),
      ">=": (t: number) => t >= cutoff.getTime(),
    }[match[1] as "<" | ">" | "<=" | ">="];
    const selected = rows.filter((row) => holds(row.created_at.getTime())).slice(0, limit);
    for (const row of selected) rows.splice(rows.indexOf(row), 1);
    return selected.map((row) => ({ id: row.id }));
  };
}

function makeDispatchPrisma(options: {
  onRateLimits?: () => Promise<unknown[]>;
  onAudit?: (sql: Sql) => Promise<unknown[]>;
  auditSqls?: Sql[];
  rateLimitSqls?: Sql[];
}) {
  return vi.fn((sql: Sql) => {
    if (sql.text.includes("audit_logs")) {
      options.auditSqls?.push(sql);
      return options.onAudit ? options.onAudit(sql) : Promise.resolve([]);
    }
    options.rateLimitSqls?.push(sql);
    return options.onRateLimits ? options.onRateLimits() : Promise.resolve([]);
  });
}

describe("CronService", () => {
  const authService = (cronSecret: string) =>
    new CronService(
      {} as never,
      {} as never,
      { cronSecret } as never,
      {} as never,
      { clearValidationCache: vi.fn() } as never,
    );

  it.each([
    ["Bearer secret", "secret", true],
    ["Bearer wrong", "secret", false],
    ["bearer secret", "secret", false],
    ["Bearer  secret", "secret", false],
    ["Bearer secret ", "secret", false],
    ["secret", "secret", false],
    ["", "secret", false],
    [undefined, "secret", false],
    ["Bearer ", "", false],
    ["", "", false],
    [undefined, "", false],
  ])("authorizes the cron header %j against secret %j: %s", (header, secret, expected) => {
    expect(authService(secret).isAuthorized(header)).toBe(expected);
  });

  describe("auto-revoking inactive keys", () => {
    function revokingService(updateMany: ReturnType<typeof vi.fn>, days: string | null) {
      const apiKeys = { clearValidationCache: vi.fn() };
      const settings = {
        getSetting: vi.fn(async (key: string) =>
          key === "api_key_inactivity_revoke_days" && days !== null ? { key, value: days } : null,
        ),
      };
      const service = new CronService(
        { $queryRaw: vi.fn().mockResolvedValue([]), apiKey: { updateMany } } as never,
        settings as never,
        { cronSecret: "secret" } as never,
        { refreshCreditUsageForKeys: vi.fn().mockResolvedValue([]) } as never,
        apiKeys as never,
      );
      return { service, apiKeys };
    }

    it("clears the validation cache when keys were revoked", async () => {
      const updateMany = vi.fn().mockResolvedValue({ count: 2 });
      const { service, apiKeys } = revokingService(updateMany, "30");

      await expect(service.runMaintenance()).resolves.toMatchObject({ revoked: 2 });

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(apiKeys.clearValidationCache).toHaveBeenCalledTimes(1);
    });

    it("leaves the validation cache alone when nothing was revoked", async () => {
      const updateMany = vi.fn().mockResolvedValue({ count: 0 });
      const { service, apiKeys } = revokingService(updateMany, "30");

      await expect(service.runMaintenance()).resolves.toMatchObject({ revoked: 0 });

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(apiKeys.clearValidationCache).not.toHaveBeenCalled();
    });

    it.each([null, "0", "-1", "abc"])(
      "does not revoke or clear the cache when the setting is %j",
      async (days) => {
        const updateMany = vi.fn();
        const { service, apiKeys } = revokingService(updateMany, days);

        await expect(service.runMaintenance()).resolves.toMatchObject({ revoked: 0 });

        expect(updateMany).not.toHaveBeenCalled();
        expect(apiKeys.clearValidationCache).not.toHaveBeenCalled();
      },
    );
  });

  it("refreshes configured credit pools as part of daily maintenance", async () => {
    const key = "fc_cron_key_12345678";
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const settings = {
      getSetting: vi
        .fn()
        .mockResolvedValueOnce({
          key: "firecrawl_api_keys",
          value: encryptSettingValue(JSON.stringify([key]), encryptionKey),
        })
        .mockResolvedValueOnce(null),
      setSetting: vi.fn(),
    };
    const credits = {
      refreshCreditUsageForKeys: vi.fn().mockResolvedValue([{ remainingCredits: 100 }]),
    };
    const queryRaw = vi.fn().mockResolvedValue([]);
    const service = new CronService(
      { $queryRaw: queryRaw } as never,
      settings as never,
      { cronSecret: "secret", firecrawlKeysEncryptionKey: encryptionKey } as never,
      credits as never,
      { clearValidationCache: vi.fn() } as never,
    );

    await expect(service.runMaintenance()).resolves.toMatchObject({ creditUsageRefreshed: 1 });
    expect(credits.refreshCreditUsageForKeys).toHaveBeenCalledWith([key]);
  });

  it("migrates a legacy plaintext key setting conditionally during credit refresh", async () => {
    const key = "fc_cron_key_12345678";
    const plaintext = JSON.stringify([key]);
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const settings = {
      getSetting: vi
        .fn()
        .mockResolvedValueOnce({ key: "firecrawl_api_keys", value: plaintext })
        .mockResolvedValueOnce(null),
      setSetting: vi.fn(),
      replaceSettingIfUnchanged: vi.fn().mockResolvedValue(true),
    };
    const credits = {
      refreshCreditUsageForKeys: vi.fn().mockResolvedValue([{ remainingCredits: 100 }]),
    };
    const service = new CronService(
      { $queryRaw: vi.fn().mockResolvedValue([]) } as never,
      settings as never,
      { cronSecret: "secret", firecrawlKeysEncryptionKey: encryptionKey } as never,
      credits as never,
      { clearValidationCache: vi.fn() } as never,
    );

    await service.runMaintenance();

    expect(settings.replaceSettingIfUnchanged).toHaveBeenCalledWith(
      "firecrawl_api_keys",
      plaintext,
      expect.stringMatching(/^enc:v1:/),
    );
    expect(settings.setSetting).not.toHaveBeenCalled();
  });

  it("cleans a drained batch of expired rate-limit rows and reports both prune totals", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ key: "expired-1" }, { key: "expired-2" }])
      .mockResolvedValue([]);
    const service = makeService(queryRaw);

    await expect(service.runMaintenance()).resolves.toEqual({
      revoked: 0,
      rateLimitsDeleted: 2,
      auditLogsDeleted: 0,
      creditUsageRefreshed: 0,
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("prunes only audit rows older than the 30-day retention window", async () => {
    const now = Date.now();
    const rows: FakeAuditRow[] = [
      { id: "old-1", created_at: new Date(now - 31 * 24 * 60 * 60 * 1000) },
      { id: "old-2", created_at: new Date(now - 45 * 24 * 60 * 60 * 1000) },
      { id: "fresh-1", created_at: new Date(now - 1 * 24 * 60 * 60 * 1000) },
      { id: "boundary-fresh", created_at: new Date(now) },
    ];
    const queryRaw = vi.fn((sql: Sql) =>
      sql.text.includes("audit_logs") ? makeAuditFake(rows)(sql) : Promise.resolve([]),
    );
    const service = makeService(queryRaw);

    const result = await service.runMaintenance();

    expect(result.auditLogsDeleted).toBe(2);
    expect(rows.map((row) => row.id)).toEqual(["fresh-1", "boundary-fresh"]);
  });

  it("parameterizes an explicit past cutoff for the audit prune", async () => {
    const before = Date.now();
    const auditSqls: Sql[] = [];
    const queryRaw = makeDispatchPrisma({ auditSqls, onAudit: () => Promise.resolve([]) });
    const service = makeService(queryRaw);

    await service.runMaintenance();

    expect(auditSqls).toHaveLength(1);
    const sql = auditSqls[0];
    // Direction is encoded in the SQL text: strictly older-than cutoff.
    expect(sql.text).toMatch(/created_at\s*<\s*\$1/);
    expect(sql.text).not.toMatch(/created_at\s*>=?\s*\$1/);
    const cutoff = sql.values[0] as Date;
    expect(cutoff).toBeInstanceOf(Date);
    const expected = before - 30 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expected - 5_000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - 30 * 24 * 60 * 60 * 1000 + 5_000);
  });

  it("stops pruning when a batch returns fewer rows than the batch size", async () => {
    const rateLimitSqls: Sql[] = [];
    const fullBatch = Array.from({ length: BATCH_SIZE }, (_, i) => ({ key: `k-${i}` }));
    const shortBatch = Array.from({ length: 2_000 }, (_, i) => ({ key: `s-${i}` }));
    let rateLimitCall = 0;
    const queryRaw = makeDispatchPrisma({
      rateLimitSqls,
      onRateLimits: () => {
        rateLimitCall += 1;
        return Promise.resolve(rateLimitCall === 1 ? fullBatch : shortBatch);
      },
    });
    const service = makeService(queryRaw);

    const result = await service.runMaintenance();

    expect(result.rateLimitsDeleted).toBe(BATCH_SIZE + 2_000);
    expect(rateLimitSqls).toHaveLength(2);
    expect(Number(rateLimitSqls[0].values.at(-1))).toBe(BATCH_SIZE);
  });

  it("caps a never-draining prune at the iteration bound", async () => {
    const auditSqls: Sql[] = [];
    const fullBatch = Array.from({ length: BATCH_SIZE }, (_, i) => ({ id: `a-${i}` }));
    const queryRaw = makeDispatchPrisma({
      auditSqls,
      onAudit: () => Promise.resolve(fullBatch),
    });
    const service = makeService(queryRaw);

    const result = await service.runMaintenance();

    expect(result.auditLogsDeleted).toBe(BATCH_SIZE * MAX_BATCHES);
    expect(auditSqls).toHaveLength(MAX_BATCHES);
  });
});
