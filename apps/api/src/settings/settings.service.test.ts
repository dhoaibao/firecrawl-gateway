import { describe, expect, it, vi } from "vitest";
import { SettingsService } from "./settings.service";

const at = new Date("2026-01-01T00:00:00.000Z");

function makePrisma(rows: Array<{ key: string; value: string; updatedAt: Date }>) {
  return {
    setting: {
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        rows.filter((row) => where.key.in.includes(row.key)),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) =>
          rows.find((row) => row.key === where.key) ?? null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string; value: string };
          data: { value: string };
        }) => {
          const matched = rows.filter((r) => r.key === where.key && r.value === where.value);
          for (const row of matched) row.value = data.value;
          return { count: matched.length };
        },
      ),
      upsert: vi.fn(async ({ create }: { create: { key: string; value: string } }) => ({
        ...create,
        updatedAt: at,
      })),
    },
  };
}

describe("SettingsService.getSettings", () => {
  it("fetches all cache misses in one query and returns null for absent keys", async () => {
    const prisma = makePrisma([{ key: "a", value: "1", updatedAt: at }]);
    const service = new SettingsService(prisma as never);

    await expect(service.getSettings(["a", "b"])).resolves.toEqual({
      a: { key: "a", value: "1", updated_at: at.toISOString() },
      b: null,
    });
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it("queries only keys missing from the cache and shares the per-key cache", async () => {
    const prisma = makePrisma([
      { key: "a", value: "1", updatedAt: at },
      { key: "b", value: "2", updatedAt: at },
    ]);
    const service = new SettingsService(prisma as never);
    await service.getSetting("a");

    await service.getSettings(["a", "b"]);

    expect(prisma.setting.findMany).toHaveBeenCalledWith({ where: { key: { in: ["b"] } } });
    await service.getSetting("b");
    expect(prisma.setting.findUnique).toHaveBeenCalledTimes(1);
    await service.getSettings(["a", "b"]);
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(1);
  });

  it("invalidates a batched key on setSetting", async () => {
    const prisma = makePrisma([{ key: "a", value: "1", updatedAt: at }]);
    const service = new SettingsService(prisma as never);
    await service.getSettings(["a"]);

    await service.setSetting("a", "2");
    await service.getSettings(["a"]);

    expect(prisma.setting.findMany).toHaveBeenCalledTimes(2);
  });

  it("joins an in-flight single-key read instead of re-querying it", async () => {
    const prisma = makePrisma([{ key: "a", value: "1", updatedAt: at }]);
    const service = new SettingsService(prisma as never);

    const [single, batch] = await Promise.all([
      service.getSetting("a"),
      service.getSettings(["a"]),
    ]);

    expect(batch.a).toEqual(single);
    expect(prisma.setting.findMany).not.toHaveBeenCalled();
  });

  it("propagates a database failure to every caller without caching it", async () => {
    const prisma = makePrisma([]);
    prisma.setting.findMany.mockRejectedValueOnce(new Error("db down"));
    const service = new SettingsService(prisma as never);

    await expect(service.getSettings(["a", "b"])).rejects.toThrow("db down");
    await expect(service.getSettings(["a"])).resolves.toEqual({ a: null });
  });

  it("replaceSettingIfUnchanged only writes when the stored value matches and invalidates the cache", async () => {
    const prisma = makePrisma([{ key: "a", value: "old", updatedAt: at }]);
    const service = new SettingsService(prisma as never);
    await service.getSettings(["a"]);

    await expect(service.replaceSettingIfUnchanged("a", "stale", "new")).resolves.toBe(false);
    await expect(service.replaceSettingIfUnchanged("a", "old", "new")).resolves.toBe(true);
    expect(prisma.setting.updateMany).toHaveBeenLastCalledWith({
      where: { key: "a", value: "old" },
      data: { value: "new" },
    });
    await service.getSettings(["a"]);
    expect(prisma.setting.findMany).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a value an admin changed after the legacy record was read", async () => {
    const rows = [{ key: "keys", value: "legacy-plaintext", updatedAt: at }];
    const prisma = makePrisma(rows);
    const service = new SettingsService(prisma as never);
    const stale = (await service.getSettings(["keys"])).keys!;

    rows[0].value = "admin-updated"; // concurrent admin write after the read
    await expect(
      service.replaceSettingIfUnchanged("keys", stale.value, "enc:migrated"),
    ).resolves.toBe(false);

    expect(rows[0].value).toBe("admin-updated");
  });
});
