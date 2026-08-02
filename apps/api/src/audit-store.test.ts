import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createAuditStore } from "./audit-store";
import type { AuditEntry } from "./types";

const repository = vi.hoisted(() => ({
  appendAuditEntries: vi.fn(),
  readAuditEntries: vi.fn(),
  deleteAuditEntry: vi.fn(),
  deleteAuditEntriesByIds: vi.fn(),
  deleteAuditEntries: vi.fn(),
}));

vi.mock("./audit-repository", () => repository);

const entry: AuditEntry = {
  id: "audit-write-failure",
  created_at: "2026-06-30T00:00:00.000Z",
  method: "POST",
  path: "/v2/scrape",
  route_mode: "cloud-first",
  backend_used: "cloud",
  fallback_used: false,
  fallback_reason: "",
  status_code: 200,
  duration_ms: 10,
  target_url: "",
};

describe("createAuditStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.appendAuditEntries.mockResolvedValue(undefined);
    repository.deleteAuditEntriesByIds.mockResolvedValue([]);
    repository.deleteAuditEntries.mockResolvedValue([]);
    repository.deleteAuditEntry.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists audit entries to the database when enabled", async () => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);

    const store = createAuditStore("/tmp/audit.jsonl", { persistToDatabase: true });
    await store.appendAudit(entry);
    await store.flush?.();

    expect(repository.appendAuditEntries).toHaveBeenCalledWith([entry]);
  });

  it("persists queued entries in database batches", async () => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);

    const store = createAuditStore("/tmp/audit.jsonl", { persistToDatabase: true });
    for (let index = 0; index < 101; index++) {
      void store.appendAudit({ ...entry, id: `audit-${index}` });
    }
    await store.flush?.();

    expect(repository.appendAuditEntries).toHaveBeenCalledTimes(2);
    expect(repository.appendAuditEntries.mock.calls.map(([entries]) => (entries as AuditEntry[]).length).sort((a, b) => a - b))
      .toEqual([1, 100]);
  });

  it("falls back to individual database writes when a batch fails", async () => {
    repository.appendAuditEntries
      .mockRejectedValueOnce(Object.assign(new Error("batch constraint failure"), { code: "23503" }))
      .mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);

    const store = createAuditStore("/tmp/audit.jsonl", { persistToDatabase: true });
    void store.appendAudit(entry);
    void store.appendAudit({ ...entry, id: "audit-second" });
    await store.flush?.();

    expect(repository.appendAuditEntries).toHaveBeenCalledTimes(3);
    expect(repository.appendAuditEntries.mock.calls.slice(1).every(([entries]) => (entries as AuditEntry[]).length === 1)).toBe(true);
  });

  it("does not amplify transient database failures with individual retries", async () => {
    repository.appendAuditEntries.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);

    const store = createAuditStore("/tmp/audit.jsonl", { persistToDatabase: true });
    for (let index = 0; index < 101; index++) {
      void store.appendAudit({ ...entry, id: `audit-transient-${index}` });
    }
    await store.flush?.();

    expect(repository.appendAuditEntries).toHaveBeenCalledTimes(2);
    expect(repository.appendAuditEntries.mock.calls.map(([entries]) => (entries as AuditEntry[]).length).sort((a, b) => a - b))
      .toEqual([1, 100]);
  });

  it("uses the repository's UTC-aware deletion operation", async () => {
    repository.deleteAuditEntries.mockResolvedValue(["audit-one"]);
    vi.spyOn(fs, "writeFile").mockResolvedValue(undefined);

    const store = createAuditStore("/tmp/audit.jsonl", { persistToDatabase: true });
    await store.deleteAuditEntries("today");

    expect(repository.deleteAuditEntries).toHaveBeenCalledWith("today");
  });

  it("deletes selected audit entries by id", async () => {
    repository.deleteAuditEntriesByIds.mockResolvedValue(["audit-one", "audit-two"]);
    vi.spyOn(fs, "access").mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const store = createAuditStore("/tmp/missing-audit.jsonl", { persistToDatabase: true });
    await expect(store.deleteAuditEntriesByIds(["audit-one", "audit-two", "audit-one"])).resolves.toBe(2);
    expect(repository.deleteAuditEntriesByIds).toHaveBeenCalledWith(["audit-one", "audit-two"]);
  });

  it("deletes selected entries from JSONL while preserving other lines", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "audit-store-"));
    const logFile = path.join(directory, "audit.jsonl");
    try {
      await fs.writeFile(logFile, [
        JSON.stringify({ ...entry, id: "audit-delete" }),
        "malformed line",
        JSON.stringify({ ...entry, id: "audit-keep" }),
      ].join("\n") + "\n");

      const store = createAuditStore(logFile);
      await expect(store.deleteAuditEntriesByIds(["audit-delete"])).resolves.toBe(1);
      const contents = await fs.readFile(logFile, "utf8");
      expect(contents).not.toContain('"id":"audit-delete"');
      expect(contents).toContain("malformed line");
      expect(contents).toContain('"id":"audit-keep"');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes appends with selected-log deletion", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "audit-store-"));
    const logFile = path.join(directory, "audit.jsonl");
    try {
      await fs.writeFile(logFile, JSON.stringify({ ...entry, id: "audit-delete" }) + "\n");
      const store = createAuditStore(logFile);
      const deletion = store.deleteAuditEntriesByIds(["audit-delete"]);
      await store.appendAudit({ ...entry, id: "audit-keep" });
      await expect(deletion).resolves.toBe(1);
      await store.flush?.();
      const contents = await fs.readFile(logFile, "utf8");
      expect(contents).not.toContain('"id":"audit-delete"');
      expect(contents).toContain('"id":"audit-keep"');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("reports database deletions when the JSONL file is missing", async () => {
    repository.deleteAuditEntries.mockResolvedValue(["audit-one", "audit-two", "audit-three"]);
    vi.spyOn(fs, "access").mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const store = createAuditStore("/tmp/missing-audit.jsonl", { persistToDatabase: true });
    await expect(store.deleteAuditEntries("today")).resolves.toBe(3);
  });

  it("counts distinct ids across overlapping database and file deletions", async () => {
    repository.deleteAuditEntriesByIds.mockResolvedValue(["audit-overlap", "audit-db-only"]);
    const directory = await fs.mkdtemp(path.join(tmpdir(), "audit-store-"));
    const logFile = path.join(directory, "audit.jsonl");
    try {
      await fs.writeFile(logFile, [
        JSON.stringify({ ...entry, id: "audit-overlap" }),
        JSON.stringify({ ...entry, id: "audit-overlap" }),
        JSON.stringify({ ...entry, id: "audit-file-only" }),
      ].join("\n") + "\n");

      const store = createAuditStore(logFile, { persistToDatabase: true });
      await expect(store.deleteAuditEntriesByIds(["audit-overlap", "audit-db-only", "audit-file-only"])).resolves.toBe(3);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("counts distinct ids for all-history deletion with duplicate file lines", async () => {
    repository.deleteAuditEntries.mockResolvedValue(["audit-overlap", "audit-db-only"]);
    const directory = await fs.mkdtemp(path.join(tmpdir(), "audit-store-"));
    const logFile = path.join(directory, "audit.jsonl");
    try {
      await fs.writeFile(logFile, [
        JSON.stringify({ ...entry, id: "audit-overlap" }),
        JSON.stringify({ ...entry, id: "audit-overlap" }),
        JSON.stringify({ ...entry, id: "audit-file-only" }),
        JSON.stringify({ ...entry, id: "audit-file-only" }),
      ].join("\n") + "\n");

      const store = createAuditStore(logFile, { persistToDatabase: true });
      await expect(store.deleteAuditEntries("all")).resolves.toBe(3);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("logs when an audit entry cannot be persisted without blocking the request", async () => {
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    vi.spyOn(fs, "appendFile").mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    const store = createAuditStore("/data/hybrid-firecrawl-requests.jsonl");
    await expect(store.appendAudit(entry)).resolves.toBeUndefined();
    await expect(store.flush!()).resolves.toBeUndefined();
  });

  it("times out and discards queued database audits", async () => {
    vi.useFakeTimers();
    try {
      repository.appendAuditEntries.mockReturnValue(new Promise<void>(() => {}));
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
      vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
      const store = createAuditStore("/tmp/audit.jsonl", { persistToDatabase: true });
      await store.appendAudit(entry);
      await store.appendAudit({ ...entry, id: "queued-after-first" });
      const flushPromise = store.flush!(10);
      await vi.advanceTimersByTimeAsync(10);
      await flushPromise;
      expect(repository.appendAuditEntries).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes database writes when a timed-out store is reused", async () => {
    vi.useFakeTimers();
    let releaseFirstWrite: (() => void) | undefined;
    try {
      const firstWrite = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });
      repository.appendAuditEntries
        .mockImplementationOnce(() => firstWrite)
        .mockResolvedValue(undefined);
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
      vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
      const store = createAuditStore("/tmp/audit.jsonl", { persistToDatabase: true });

      await store.appendAudit(entry);
      const flushPromise = store.flush!(10);
      await vi.advanceTimersByTimeAsync(10);
      await flushPromise;
      expect(repository.appendAuditEntries).toHaveBeenCalledTimes(1);

      await store.appendAudit({ ...entry, id: "audit-after-timeout" });
      releaseFirstWrite?.();
      await store.flush!();

      expect(repository.appendAuditEntries).toHaveBeenCalledTimes(2);
      expect(repository.appendAuditEntries.mock.calls[1]).toEqual([[{ ...entry, id: "audit-after-timeout" }]]);
    } finally {
      releaseFirstWrite?.();
      vi.useRealTimers();
    }
  });
});
