import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSettingValue } from "../common/crypto";
import { UserCloudKeysService } from "./user-cloud-keys.service";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY = "f".repeat(64);

function row(id: string, value: string, role = "cloud") {
  return { id, keyValue: value, role };
}

function makeService(rows: ReturnType<typeof row>[] | Error) {
  const findMany = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const service = new UserCloudKeysService(
    { userCloudKey: { findMany } } as never,
    { firecrawlKeysEncryptionKey: ENCRYPTION_KEY } as never,
  );
  return { service, findMany };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("UserCloudKeysService", () => {
  it("decrypts only the requested user's keys, in creation order, with their roles", async () => {
    const { service, findMany } = makeService([
      row("k1", encryptSettingValue("fc-user-key-one-aaaaaaaa", ENCRYPTION_KEY)),
      row("k2", encryptSettingValue("fc-user-key-two-bbbbbbbb", ENCRYPTION_KEY), "fallback"),
    ]);

    const entries = await service.loadEntries("user-1");

    expect(entries).toEqual([
      { key: "fc-user-key-one-aaaaaaaa", role: "cloud" },
      { key: "fc-user-key-two-bbbbbbbb", role: "fallback" },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { createdAt: "asc" },
      select: { id: true, keyValue: true, role: true },
    });
  });

  it("returns no entries for a user without keys", async () => {
    const { service } = makeService([]);

    await expect(service.loadEntries("user-1")).resolves.toEqual([]);
  });

  it("skips plaintext rows and rows it cannot decrypt, without leaking material in logs", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const secret = "fc-secret-that-must-not-be-logged-1234";
    const { service } = makeService([
      row("plain", secret), // not encrypted: not trusted
      row("wrong", encryptSettingValue(secret, OTHER_KEY)), // other encryption key
      row("ok", encryptSettingValue("fc-good-key-aaaaaaaaaaaa", ENCRYPTION_KEY)),
    ]);

    const entries = await service.loadEntries("user-1");

    expect(entries).toEqual([{ key: "fc-good-key-aaaaaaaaaaaa", role: "cloud" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).not.toContain(secret);
    expect(message).toContain("id wrong");
  });

  it("caches per user for a short time and returns copies", async () => {
    vi.useFakeTimers();
    const { service, findMany } = makeService([
      row("k1", encryptSettingValue("fc-user-key-one-aaaaaaaa", ENCRYPTION_KEY)),
    ]);

    const first = await service.loadEntries("user-1");
    first.push({ key: "mutated", role: "cloud" });
    const second = await service.loadEntries("user-1");
    await service.loadEntries("user-2");

    expect(second).toEqual([{ key: "fc-user-key-one-aaaaaaaa", role: "cloud" }]);
    expect(findMany).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(30_001);
    await service.loadEntries("user-1");
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("reloads right after invalidate", async () => {
    const { service, findMany } = makeService([]);
    await service.loadEntries("user-1");

    service.invalidate("user-1");
    await service.loadEntries("user-1");

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("rejects on a database failure instead of reporting an empty key list", async () => {
    const { service } = makeService(new Error("db down"));

    await expect(service.loadEntries("user-1")).rejects.toThrow("db down");
  });
});
