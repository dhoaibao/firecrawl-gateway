import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";
import type { PrismaService } from "../prisma/prisma.service";

function makeAuditMock() {
  return {
    readAuditEntries: vi.fn().mockResolvedValue([]),
    appendAudit: vi.fn().mockResolvedValue(undefined),
    deleteAuditEntry: vi.fn().mockResolvedValue(true),
    deleteAuditEntriesByIds: vi.fn().mockResolvedValue(0),
    deleteAuditEntries: vi.fn().mockResolvedValue(0),
    readAuditStats: vi.fn().mockResolvedValue({}),
    readApiKeyUsage: vi.fn().mockResolvedValue([]),
  };
}

function makeRow(id: string, createdAt: Date) {
  return {
    id,
    createdAt,
    method: "POST",
    path: "/v1/scrape",
    routeMode: "cloud-first",
    backendUsed: "cloud",
    fallbackUsed: false,
    fallbackReason: "",
    statusCode: 200,
    durationMs: 120,
    targetUrl: "https://firecrawl.dev",
    requestId: null,
    apiKeyId: null,
  };
}

describe("AuditController data", () => {
  it("returns all entries when since is absent", async () => {
    const audit = makeAuditMock();
    audit.readAuditEntries.mockResolvedValue([makeRow("a", new Date("2026-08-22T00:00:00.000Z"))]);
    const controller = new AuditController(audit as unknown as AuditService);

    const res = await controller.data(undefined);

    expect(audit.readAuditEntries).toHaveBeenCalledWith(500, undefined);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].id).toBe("a");
  });

  it("returns all entries when since is an empty string", async () => {
    const audit = makeAuditMock();
    const controller = new AuditController(audit as unknown as AuditService);

    await controller.data("");

    expect(audit.readAuditEntries).toHaveBeenCalledWith(500, undefined);
  });

  it("passes a valid since cursor through as a Date", async () => {
    const audit = makeAuditMock();
    const controller = new AuditController(audit as unknown as AuditService);

    await controller.data("2026-08-22T10:00:00.000Z");

    expect(audit.readAuditEntries).toHaveBeenCalledWith(500, new Date("2026-08-22T10:00:00.000Z"));
  });

  it("accepts the exact format the API emits via toISOString", async () => {
    // The dashboard cursor is the newest entry.created_at, produced by
    // nowIso() -> new Date().toISOString(); that exact format must keep working.
    const audit = makeAuditMock();
    const controller = new AuditController(audit as unknown as AuditService);
    const cursor = new Date("2026-02-14T09:26:53.489Z").toISOString();

    await controller.data(cursor);

    expect(cursor).toBe("2026-02-14T09:26:53.489Z");
    expect(audit.readAuditEntries).toHaveBeenCalledWith(500, new Date(cursor));
  });

  it("rejects a non-ISO since value with 400", async () => {
    const audit = makeAuditMock();
    const controller = new AuditController(audit as unknown as AuditService);

    await expect(controller.data("not-a-date")).rejects.toMatchObject({
      status: 400,
      response: { error: "since must be a valid ISO timestamp" },
    });
    expect(audit.readAuditEntries).not.toHaveBeenCalled();
  });

  it("rejects loose date-only and prose inputs even though Date parses them", async () => {
    const audit = makeAuditMock();
    const controller = new AuditController(audit as unknown as AuditService);

    for (const loose of ["2026-01-01", "Jan 1 2026"]) {
      await expect(controller.data(loose)).rejects.toMatchObject({
        status: 400,
        response: { error: "since must be a valid ISO timestamp" },
      });
    }
    expect(audit.readAuditEntries).not.toHaveBeenCalled();
  });

  it("returns entries newer than or equal to the cursor via the service query", async () => {
    // Two entries sharing the cursor millisecond must both survive the
    // incremental fetch: the query uses gte, not gt.
    const cursor = new Date("2026-08-22T10:00:00.000Z");
    const rows = [
      makeRow("newer", new Date("2026-08-22T10:00:01.000Z")),
      makeRow("sibling", new Date(cursor)),
      makeRow("older", new Date("2026-08-22T09:59:59.999Z")),
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = { auditLog: { findMany } } as unknown as PrismaService;
    const service = new AuditService(prisma);

    const entries = await service.readAuditEntries(500, cursor);

    expect(findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      take: 500,
      where: { createdAt: { gte: cursor } },
    });
    expect(entries.map((entry) => entry.id)).toEqual(["newer", "sibling", "older"]);
  });
});

describe("AuditController stats query parsing", () => {
  it.each(["search", "backend", "tz", "range", "day"])(
    "answers 400, not 500, for a repeated %s parameter on stats and usage",
    async (name) => {
      const audit = makeAuditMock();
      const controller = new AuditController(audit as unknown as AuditService);
      const query = { [name]: ["a", "b"] } as unknown as Record<string, string>;

      await expect(controller.stats(query)).rejects.toMatchObject({ status: 400 });
      await expect(controller.apiKeyUsage(query)).rejects.toMatchObject({ status: 400 });
      expect(audit.readAuditStats).not.toHaveBeenCalled();
      expect(audit.readApiKeyUsage).not.toHaveBeenCalled();
    },
  );

  it("still accepts single string parameters", async () => {
    const audit = makeAuditMock();
    const controller = new AuditController(audit as unknown as AuditService);

    await controller.stats({ search: "scrape", backend: "cloud" });

    expect(audit.readAuditStats).toHaveBeenCalledWith(
      expect.objectContaining({ search: "scrape", backend: "cloud" }),
    );
  });
});

describe("AuditService readAuditStats", () => {
  it("aggregates over the whole table without a row cap", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        total: 1900,
        self_hosted: 400,
        cloud: 1500,
        fallbacks: 20,
        success_count: 1700,
        error_count: 150,
        avg_duration_ms: 124,
      },
    ]);
    const service = new AuditService({ $queryRaw: queryRaw } as unknown as PrismaService);

    await expect(service.readAuditStats()).resolves.toMatchObject({ total: 1900, cloud: 1500 });
    const sql = queryRaw.mock.calls[0][0] as { sql: string };
    expect(sql.sql).not.toMatch(/LIMIT/i);
    expect(sql.sql).not.toMatch(/^\s*WHERE/m);
  });

  it("returns zeros for an empty result", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const service = new AuditService({ $queryRaw: queryRaw } as unknown as PrismaService);
    await expect(service.readAuditStats()).resolves.toMatchObject({ total: 0, avg_duration_ms: 0 });
  });

  it("applies filters as parameterised conditions", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const service = new AuditService({ $queryRaw: queryRaw } as unknown as PrismaService);
    await service.readAuditStats({
      backend: "cloud",
      status: "4xx",
      fallbackOnly: true,
      slowOnly: true,
      search: "50%_x",
      range: "custom",
      day: 3,
      year: 2026,
      timeZone: "Asia/Ho_Chi_Minh",
    });
    const q = queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(q.sql).toMatch(/^\s*WHERE/m);
    expect(q.sql).toContain("backend_used = ?");
    expect(q.sql).toContain("fallback_used = true");
    expect(q.sql).toContain("duration_ms >= 1000");
    expect(q.values).toContain("cloud");
    expect(q.values).toContain("Asia/Ho_Chi_Minh");
    expect(q.values).toContain("%50\\%\\_x%");
    expect(q.values).toContain(3);
    expect(q.values).toContain(2026);
  });

  it("subtracts the week as absolute hours to match the dashboard across DST", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const service = new AuditService({ $queryRaw: queryRaw } as unknown as PrismaService);
    await service.readAuditStats({ range: "week", timeZone: "America/New_York" });
    const q = queryRaw.mock.calls[0][0] as { sql: string };
    expect(q.sql).toContain("interval '168 hours'");
    expect(q.sql).not.toContain("interval '7 days'");
  });

  it("exposes stats through the controller with parsed filters", async () => {
    const audit = makeAuditMock();
    audit.readAuditStats.mockResolvedValue({ total: 1 });
    const controller = new AuditController(audit as unknown as AuditService);
    await expect(
      controller.stats({
        backend: "cloud",
        range: "today",
        tz: "Asia/Ho_Chi_Minh",
        fallback: "true",
      }),
    ).resolves.toEqual({ data: { total: 1 } });
    expect(audit.readAuditStats).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "cloud",
        range: "today",
        timeZone: "Asia/Ho_Chi_Minh",
        fallbackOnly: true,
      }),
    );
  });

  it("rejects invalid filter params", async () => {
    const audit = makeAuditMock();
    const controller = new AuditController(audit as unknown as AuditService);
    await expect(controller.stats({ backend: "nope" })).rejects.toBeDefined();
    await expect(controller.stats({ day: "40" })).rejects.toBeDefined();
    await expect(controller.stats({ tz: "Not/AZone; DROP" })).rejects.toBeDefined();
    await expect(controller.stats({ api_key_id: "x'; DROP TABLE" })).rejects.toBeDefined();
    await expect(controller.stats({ api_key_id: "a".repeat(65) })).rejects.toBeDefined();
    expect(audit.readAuditStats).not.toHaveBeenCalled();
  });

  it("filters stats by API key as a parameterised condition", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const service = new AuditService({ $queryRaw: queryRaw } as unknown as PrismaService);

    await service.readAuditStats({ apiKeyId: "0b1e7c1a-5a53-4d41-9a39-3d5f6d1f5a10" });

    const q = queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(q.sql).toContain("api_key_id = ?");
    expect(q.values).toContain("0b1e7c1a-5a53-4d41-9a39-3d5f6d1f5a10");
  });
});

describe("AuditService API key attribution", () => {
  it("persists the key id, or null when the request had none", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);
    const base = {
      id: "a",
      created_at: "2026-08-22T00:00:00.000Z",
      method: "POST",
      path: "/v1/scrape",
      route_mode: "cloud-first",
      backend_used: "cloud",
      fallback_used: false,
      fallback_reason: "",
      status_code: 200,
      duration_ms: 12,
      target_url: "",
    };

    await service.appendAudit({ ...base, api_key_id: "key-1" });
    await service.appendAudit({ ...base, id: "b" });
    await service.onModuleDestroy();

    const rows = createMany.mock.calls[0][0].data;
    expect(rows[0].apiKeyId).toBe("key-1");
    expect(rows[1].apiKeyId).toBeNull();
  });

  it("exposes the key id on read entries", async () => {
    const rows = [
      { ...makeRow("a", new Date("2026-08-22T00:00:00.000Z")), apiKeyId: "key-1" },
      makeRow("b", new Date("2026-08-22T00:00:01.000Z")),
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const service = new AuditService({ auditLog: { findMany } } as unknown as PrismaService);

    const entries = await service.readAuditEntries(500);

    expect(entries[0].api_key_id).toBe("key-1");
    expect(entries[1].api_key_id).toBeUndefined();
  });
});

describe("AuditService readApiKeyUsage", () => {
  it("groups by key, keeps the unattributed bucket, and normalises numbers", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        api_key_id: "key-1",
        total: 10,
        error_count: 2,
        fallbacks: 1,
        avg_duration_ms: 150,
        last_request_at: new Date("2026-08-22T10:00:00.000Z"),
      },
      {
        api_key_id: null,
        total: 3n,
        error_count: 3n,
        fallbacks: 0n,
        avg_duration_ms: null,
        last_request_at: null,
      },
    ]);
    const service = new AuditService({ $queryRaw: queryRaw } as unknown as PrismaService);

    const usage = await service.readApiKeyUsage({ range: "week", timeZone: "UTC" });

    expect(usage).toEqual([
      {
        api_key_id: "key-1",
        total: 10,
        error_count: 2,
        fallbacks: 1,
        avg_duration_ms: 150,
        last_request_at: "2026-08-22T10:00:00.000Z",
      },
      {
        api_key_id: null,
        total: 3,
        error_count: 3,
        fallbacks: 0,
        avg_duration_ms: 0,
        last_request_at: null,
      },
    ]);
    const q = queryRaw.mock.calls[0][0] as { sql: string };
    expect(q.sql).toContain("GROUP BY api_key_id");
    expect(q.sql).toContain("168 hours");
  });

  it("exposes usage through the controller with parsed filters", async () => {
    const audit = makeAuditMock();
    audit.readApiKeyUsage.mockResolvedValue([{ api_key_id: "key-1", total: 1 }]);
    const controller = new AuditController(audit as unknown as AuditService);

    await expect(controller.apiKeyUsage({ range: "month", tz: "UTC" })).resolves.toEqual({
      data: [{ api_key_id: "key-1", total: 1 }],
    });
    expect(audit.readApiKeyUsage).toHaveBeenCalledWith(
      expect.objectContaining({ range: "month", timeZone: "UTC" }),
    );
    await expect(controller.apiKeyUsage({ range: "decade" })).rejects.toBeDefined();
  });
});

describe("AuditService batched writes", () => {
  const entry = (id: string) => ({
    id,
    created_at: "2026-10-22T00:00:00.000Z",
    method: "POST",
    path: "/v1/scrape",
    route_mode: "cloud-first",
    backend_used: "cloud",
    fallback_used: false,
    fallback_reason: "",
    status_code: 200,
    duration_ms: 12,
    target_url: "",
  });
  const ids = (call: unknown[]) =>
    (call[0] as { data: Array<{ id: string }> }).data.map((r) => r.id);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns before the insert and writes queued entries in one batch after the interval", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);

    await service.appendAudit(entry("a"));
    await service.appendAudit(entry("b"));
    expect(createMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(ids(createMany.mock.calls[0])).toEqual(["a", "b"]);
  });

  it("writes a full batch at once without waiting for the interval", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 200 });
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);

    for (let i = 0; i < 200; i += 1) await service.appendAudit(entry(String(i)));
    await vi.advanceTimersByTimeAsync(0);

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(ids(createMany.mock.calls[0])).toHaveLength(200);
  });

  it("drains every entry on shutdown, including ones queued while a batch is in flight", async () => {
    let release!: () => void;
    const createMany = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ count: 1 });
          }),
      )
      .mockResolvedValue({ count: 1 });
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);

    await service.appendAudit(entry("a"));
    await vi.advanceTimersByTimeAsync(1_000); // batch "a" in flight
    await service.appendAudit(entry("b"));
    const draining = service.onModuleDestroy();
    release();
    await draining;

    expect(createMany.mock.calls.flatMap((call) => ids(call))).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(createMany).toHaveBeenCalledTimes(2);
  });

  it("keeps flushing on the timer after a timer fires during a slow write", async () => {
    let release!: () => void;
    const createMany = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ count: 1 });
          }),
      )
      .mockResolvedValue({ count: 1 });
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);

    await service.appendAudit(entry("a"));
    await vi.advanceTimersByTimeAsync(1_000); // "a" in flight and hanging
    await service.appendAudit(entry("b")); // schedules a timer
    await vi.advanceTimersByTimeAsync(1_000); // that timer fires while "a" is still in flight
    release();
    await vi.advanceTimersByTimeAsync(0); // the in-flight loop also writes "b"
    expect(createMany.mock.calls.flatMap((call) => ids(call))).toEqual(["a", "b"]);

    await service.appendAudit(entry("c"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(createMany.mock.calls.flatMap((call) => ids(call))).toEqual(["a", "b", "c"]);
  });

  it("retries a rejected batch row by row so valid entries survive a bad one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const createMany = vi.fn().mockRejectedValue(new Error("batch rejected"));
    const create = vi.fn(async ({ data }: { data: { id: string } }) => {
      if (data.id === "bad") throw new Error("row rejected");
      return data;
    });
    const service = new AuditService({
      auditLog: { createMany, create },
    } as unknown as PrismaService);

    await expect(service.appendAudit(entry("a"))).resolves.toBeUndefined();
    await service.appendAudit(entry("bad"));
    await service.appendAudit(entry("c"));
    await service.onModuleDestroy();

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(create.mock.calls.map(([arg]) => arg.data.id)).toEqual(["a", "bad", "c"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Failed to write audit entry", {
      id: "bad",
      error: expect.any(Error),
    });
  });

  it("strips NUL, which PostgreSQL text rejects, from request-derived fields", async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);

    await service.appendAudit({
      ...entry("a"),
      target_url: "https://example.com/\u0000x",
      request_id: "req\u0000-1",
    });
    await service.onModuleDestroy();

    const [row] = createMany.mock.calls[0][0].data;
    expect(row.targetUrl).toBe("https://example.com/x");
    expect(row.requestId).toBe("req-1");
  });

  it("bounds the queue by size and splits batches by size for long target URLs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let release!: () => void;
    const createMany = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ count: 1 });
          }),
      )
      .mockResolvedValue({ count: 1 });
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);
    const url = `https://example.com/${"a".repeat(3 * 1024 * 1024)}`; // about 3 MiB

    // 32 MiB fits ten such rows (queued plus in flight); the rest are dropped.
    for (let i = 0; i < 15; i += 1)
      await service.appendAudit({ ...entry(String(i)), target_url: url });
    await vi.advanceTimersByTimeAsync(1_000); // one batch hangs in flight

    expect(
      warn.mock.calls.filter(([message]) => String(message).startsWith("Dropped")),
    ).toHaveLength(5);
    // A 4 MiB batch holds one 3 MiB row.
    expect(ids(createMany.mock.calls[0])).toEqual(["0"]);

    // In-flight bytes still count, so nothing more is admitted until the write settles.
    await service.appendAudit({ ...entry("late"), target_url: url });
    expect(
      warn.mock.calls.filter(([message]) => String(message).startsWith("Dropped")),
    ).toHaveLength(6);

    release();
    await service.onModuleDestroy();
    expect(createMany.mock.calls.every((call) => ids(call).length === 1)).toBe(true);
    expect(createMany.mock.calls.flatMap((call) => ids(call))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i)),
    );

    // Once written, the budget is free again.
    await service.appendAudit({ ...entry("after"), target_url: url });
    await service.onModuleDestroy();
    expect(createMany.mock.calls.at(-1) && ids(createMany.mock.calls.at(-1)!)).toEqual(["after"]);
  });

  it("drops entries once the queue is full instead of growing without bound", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The database never answers, so nothing leaves the queue.
    const createMany = vi.fn(() => new Promise(() => undefined));
    const service = new AuditService({ auditLog: { createMany } } as unknown as PrismaService);

    for (let i = 0; i < 10_500; i += 1) await service.appendAudit(entry(String(i)));

    // One batch left the queue for the hung insert; the queue then filled to its cap.
    expect(warn).toHaveBeenCalledWith("Dropped audit entry: write queue is full", {
      id: expect.any(String),
    });
    expect(
      warn.mock.calls.filter(([message]) => String(message).startsWith("Dropped")),
    ).toHaveLength(10_500 - 200 - 10_000);
  });
});
