import { describe, expect, it, vi } from "vitest";
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
    const create = vi.fn().mockResolvedValue(undefined);
    const service = new AuditService({ auditLog: { create } } as unknown as PrismaService);
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

    expect(create.mock.calls[0][0].data.apiKeyId).toBe("key-1");
    expect(create.mock.calls[1][0].data.apiKeyId).toBeNull();
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
