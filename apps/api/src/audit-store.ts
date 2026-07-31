import type { AuditEntry } from "./types";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { rootLogger } from "./logger";
import { withClient } from "./db";

export type DeleteFilter = "today" | "week" | "month" | "all";

export interface AuditStore {
  appendAudit(entry: AuditEntry): Promise<void>;
  readAuditEntries(limit?: number): Promise<AuditEntry[]>;
  deleteAuditEntry(id: string): Promise<boolean>;
  deleteAuditEntriesByIds(ids: string[]): Promise<number>;
  deleteAuditEntries(filter: DeleteFilter): Promise<number>;
  flush?: (timeoutMs?: number) => Promise<void>;
}

interface AuditStoreOptions {
  persistToDatabase?: boolean;
}

/** Read the last N lines from a file efficiently (tail-read).
 *  Accumulates chunks as raw Buffers and decodes once to avoid UTF-8
 *  boundary corruption and uninitialized-buffer leaks. */
async function readLastLines(filePath: string, lineCount: number): Promise<string[]> {
  if (lineCount <= 0) return [];
  const CHUNK_SIZE = 8192;
  let fileHandle: fs.FileHandle | undefined;
  try {
    fileHandle = await fs.open(filePath, "r");
    const stats = await fileHandle.stat();
    const size = stats.size;
    if (size === 0) return [];

    const chunks: Buffer[] = [];
    let position = size;
    let totalNewlines = 0;

    while (position > 0 && totalNewlines <= lineCount) {
      const chunkSize = Math.min(CHUNK_SIZE, position);
      position -= chunkSize;
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await fileHandle.read(buffer, 0, chunkSize, position);
      if (bytesRead === 0) break;

      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);

      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) totalNewlines++;
      }
    }

    const text = Buffer.concat(chunks).toString("utf8");
    return text.split("\n").filter(Boolean).slice(-lineCount);
  } finally {
    await fileHandle?.close();
  }
}

const MAX_PENDING_AUDITS = 10_000;
const DATABASE_AUDIT_BATCH_SIZE = 100;

export function createAuditStore(logFile: string, options: AuditStoreOptions = {}): AuditStore {
  const pendingFileEntries: AuditEntry[] = [];
  const pendingDatabaseEntries: AuditEntry[] = [];
  let fileFlushPromise: Promise<void> | null = null;
  let fileOperationPromise: Promise<void> = Promise.resolve();
  let databaseFlushPromise: Promise<void> | null = null;
  let discardPending = false;

  async function persistAuditEntryToDatabase(entry: AuditEntry): Promise<void> {
    try {
      await withClient((client) => client.query(
        `INSERT INTO audit_logs
           (id, created_at, method, path, route_mode, backend_used, fallback_used,
            fallback_reason, status_code, duration_ms, target_url, user_id, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.id,
          entry.created_at,
          entry.method,
          entry.path,
          entry.route_mode,
          entry.backend_used,
          entry.fallback_used,
          entry.fallback_reason,
          entry.status_code,
          entry.duration_ms,
          entry.target_url,
          entry.user_id ?? null,
          entry.request_id ?? null,
        ],
      ));
    } catch (err) {
      rootLogger.warn({ err, auditId: entry.id }, "Failed to write audit entry to database");
    }
  }

  async function persistAuditBatchToDatabase(entries: AuditEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const values: unknown[] = [];
    const placeholders = entries.map((entry, entryIndex) => {
      const offset = entryIndex * 13;
      values.push(
        entry.id,
        entry.created_at,
        entry.method,
        entry.path,
        entry.route_mode,
        entry.backend_used,
        entry.fallback_used,
        entry.fallback_reason,
        entry.status_code,
        entry.duration_ms,
        entry.target_url,
        entry.user_id ?? null,
        entry.request_id ?? null,
      );
      return `(${Array.from({ length: 13 }, (_, valueIndex) => `$${offset + valueIndex + 1}`).join(", ")})`;
    }).join(",\n           ");

    try {
      await withClient((client) => client.query(
        `INSERT INTO audit_logs
           (id, created_at, method, path, route_mode, backend_used, fallback_used,
            fallback_reason, status_code, duration_ms, target_url, user_id, request_id)
         VALUES ${placeholders}
         ON CONFLICT (id) DO NOTHING`,
        values,
      ));
    } catch (err) {
      const errorCode = (err as { code?: string }).code;
      rootLogger.warn(
        { err, count: entries.length, retryIndividually: errorCode?.startsWith("23") === true },
        "Failed to write audit batch to database",
      );
      if (!errorCode?.startsWith("23")) return;

      for (const entry of entries) {
        if (discardPending) break;
        await persistAuditEntryToDatabase(entry);
      }
    }
  }

  function enqueueFileOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = fileOperationPromise.then(operation, operation);
    fileOperationPromise = next.then(() => undefined, () => undefined);
    return next;
  }

  async function flushFileEntries(): Promise<void> {
    if (fileFlushPromise) return fileFlushPromise;

    fileFlushPromise = enqueueFileOperation(async () => {
      while (pendingFileEntries.length > 0) {
        const entries = pendingFileEntries.splice(0, pendingFileEntries.length);
        try {
          await fs.mkdir(path.dirname(logFile), { recursive: true });
          await fs.appendFile(
            logFile,
            entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
            "utf8",
          );
        } catch (err) {
          rootLogger.error({ err, count: entries.length }, "Failed to write audit entries");
        }
      }
    }).finally(() => {
      fileFlushPromise = null;
    });

    return fileFlushPromise;
  }

  async function flushDatabaseEntries(): Promise<void> {
    if (databaseFlushPromise) return databaseFlushPromise;

    databaseFlushPromise = (async () => {
      while (pendingDatabaseEntries.length > 0) {
        const entries = pendingDatabaseEntries.splice(0, pendingDatabaseEntries.length);
        for (let offset = 0; offset < entries.length && !discardPending; offset += DATABASE_AUDIT_BATCH_SIZE) {
          await persistAuditBatchToDatabase(entries.slice(offset, offset + DATABASE_AUDIT_BATCH_SIZE));
        }
      }
    })().finally(() => {
      databaseFlushPromise = null;
    });

    return databaseFlushPromise;
  }

  function enqueueDatabaseWrite(entry: AuditEntry): void {
    if (pendingDatabaseEntries.length >= MAX_PENDING_AUDITS) {
      rootLogger.warn({ maxPending: MAX_PENDING_AUDITS }, "Dropping database audit entry: queue is full");
      return;
    }

    pendingDatabaseEntries.push(entry);
    void flushDatabaseEntries();
  }

  async function appendAudit(entry: AuditEntry): Promise<void> {
    if (pendingFileEntries.length >= MAX_PENDING_AUDITS) {
      rootLogger.warn({ maxPending: MAX_PENDING_AUDITS }, "Dropping audit entry: queue is full");
      return;
    }

    pendingFileEntries.push(entry);
    void flushFileEntries();

    if (options.persistToDatabase) {
      enqueueDatabaseWrite(entry);
    }
  }

  async function flush(timeoutMs = Number.POSITIVE_INFINITY): Promise<void> {
    const pendingFlush = Promise.all([flushFileEntries(), flushDatabaseEntries()]);
    if (!Number.isFinite(timeoutMs)) {
      await pendingFlush;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pendingFlush,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          discardPending = true;
          pendingFileEntries.length = 0;
          pendingDatabaseEntries.length = 0;
          rootLogger.warn({ timeoutMs }, "Audit flush timed out; discarding pending entries");
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async function readAuditEntries(limit = 250): Promise<AuditEntry[]> {
    await flush();
    const databaseEntries: AuditEntry[] = [];
    if (options.persistToDatabase) {
      try {
        const result = await withClient((client) => client.query<AuditEntry>(
          `SELECT id, created_at, method, path, route_mode, backend_used, fallback_used,
                  fallback_reason, status_code, duration_ms, target_url, user_id, request_id
           FROM audit_logs
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit],
        ));
        databaseEntries.push(...result.rows);
      } catch (err) {
        rootLogger.warn({ err }, "Failed to read audit entries from database");
      }
    }

    let fileEntries: AuditEntry[] = [];
    try {
      const lines = await readLastLines(logFile, limit);
      fileEntries = lines
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((item): item is AuditEntry => item !== null)
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const entriesById = new Map<string, AuditEntry>();
    for (const entry of [...fileEntries, ...databaseEntries]) {
      entriesById.set(entry.id, entry);
    }
    return [...entriesById.values()]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit);
  }

  async function deleteAuditEntriesByIds(ids: string[]): Promise<number> {
    const uniqueIds = new Set(ids.filter(Boolean));
    if (uniqueIds.size === 0) return 0;

    await flush();
    const deletedIds = new Set<string>();

    if (options.persistToDatabase) {
      try {
        const result = await withClient((client) => client.query(
          "DELETE FROM audit_logs WHERE id = ANY($1::text[]) RETURNING id",
          [[...uniqueIds]],
        ));
        for (const row of (result.rows ?? []) as Array<{ id?: string }>) {
          if (row.id) deletedIds.add(row.id);
        }
      } catch (err) {
        rootLogger.warn({ err, count: uniqueIds.size }, "Failed to delete selected audit entries from database");
      }
    }

    return enqueueFileOperation(async () => {
      const exists = await fs.access(logFile).then(() => true).catch(() => false);
      if (!exists) return deletedIds.size;

      const kept: string[] = [];
      const stream = createReadStream(logFile, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        let entry: AuditEntry | null = null;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          kept.push(line);
          continue;
        }

        if (uniqueIds.has(entry.id)) {
          deletedIds.add(entry.id);
        } else {
          kept.push(line);
        }
      }

      if (deletedIds.size === 0) return 0;
      const tmpFile = `${logFile}.tmp-${crypto.randomUUID()}`;
      await fs.writeFile(tmpFile, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
      await fs.rename(tmpFile, logFile);
      return deletedIds.size;
    });
  }

  async function deleteAuditEntry(id: string): Promise<boolean> {
    await flush();
    let deleted = false;

    if (options.persistToDatabase) {
      try {
        const result = await withClient((client) => client.query(
          "DELETE FROM audit_logs WHERE id = $1 RETURNING id",
          [id],
        ));
        deleted = (result.rowCount ?? 0) > 0;
      } catch (err) {
        rootLogger.warn({ err, id }, "Failed to delete audit entry from database");
      }
    }

    return enqueueFileOperation(async () => {
      const exists = await fs.access(logFile).then(() => true).catch(() => false);
      if (!exists) return deleted;

      const kept: string[] = [];
      const stream = createReadStream(logFile, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        let entry: AuditEntry | null = null;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          kept.push(line);
          continue;
        }

        if (entry.id === id) {
          deleted = true;
        } else {
          kept.push(line);
        }
      }

      if (!deleted) return false;
      const tmpFile = `${logFile}.tmp-${crypto.randomUUID()}`;
      await fs.writeFile(tmpFile, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
      await fs.rename(tmpFile, logFile);
      return true;
    });
  }

  async function deleteAuditEntries(filter: DeleteFilter): Promise<number> {
    await flush();
    let deletedFromDatabase = 0;
    const deletedDatabaseIds = new Set<string>();
    if (options.persistToDatabase) {
      try {
        const result = await withClient((client) => {
          if (filter === "all") {
            return client.query("DELETE FROM audit_logs RETURNING id");
          }
          if (filter === "today") {
            return client.query(
              `DELETE FROM audit_logs
               WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                 AND created_at < date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day'
               RETURNING id`,
            );
          }
          if (filter === "month") {
            return client.query(
              `DELETE FROM audit_logs
               WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                 AND created_at < date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 month'
               RETURNING id`,
            );
          }
          return client.query(
            "DELETE FROM audit_logs WHERE created_at >= NOW() - interval '7 days' RETURNING id",
          );
        });
        deletedFromDatabase = result.rowCount ?? 0;
        for (const row of (result.rows ?? []) as Array<{ id?: string }>) {
          if (row.id) deletedDatabaseIds.add(row.id);
        }
      } catch (err) {
        rootLogger.warn({ err, filter }, "Failed to delete audit entries from database");
      }
    }

    if (filter === "all") {
      return enqueueFileOperation(async () => {
        try {
          await fs.writeFile(logFile, "", "utf8");
          return deletedFromDatabase || -1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return deletedFromDatabase;
          throw error;
        }
      });
    }

    return enqueueFileOperation(async () => {
      const now = new Date();
      const nowDate = now.toISOString().slice(0, 10);
      const nowMonth = now.toISOString().slice(0, 7);
      const exists = await fs.access(logFile).then(() => true).catch(() => false);
      if (!exists) return deletedFromDatabase;

      let deleted = 0;
      const deletedFileIds = new Set<string>();
      const kept: string[] = [];

      const stream = createReadStream(logFile, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        let entry: AuditEntry | null = null;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch {
          kept.push(line);
          continue;
        }

        const entryDate = new Date(entry.created_at);
        const entryMonth = entryDate.toISOString().slice(0, 7);
        let shouldDelete = false;

        if (filter === "today") {
          shouldDelete = entryDate.toISOString().slice(0, 10) === nowDate;
        } else if (filter === "week") {
          const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          shouldDelete = entryDate >= weekAgo;
        } else if (filter === "month") {
          shouldDelete = entryMonth === nowMonth;
        }

        if (shouldDelete) {
          deleted++;
          deletedFileIds.add(entry.id);
        } else {
          kept.push(line);
        }
      }

      const tmpFile = `${logFile}.tmp-${crypto.randomUUID()}`;
      await fs.writeFile(tmpFile, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
      await fs.rename(tmpFile, logFile);
      if (deletedDatabaseIds.size > 0) {
        const uniqueDeletedIds = new Set(deletedDatabaseIds);
        for (const id of deletedFileIds) uniqueDeletedIds.add(id);
        return uniqueDeletedIds.size;
      }
      // Keep compatibility with database clients/tests that only expose rowCount.
      return Math.max(deleted, deletedFromDatabase);
    });
  }

  return { appendAudit, readAuditEntries, deleteAuditEntry, deleteAuditEntriesByIds, deleteAuditEntries, flush };
}
