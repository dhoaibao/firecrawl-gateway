import { describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller";

function makeReply() {
  const reply = { code: vi.fn(), send: vi.fn((body: unknown) => body) };
  reply.code.mockReturnValue(reply);
  return reply;
}

describe("HealthController", () => {
  it("reports liveness without touching the database", () => {
    const prisma = { $queryRaw: vi.fn() };
    const controller = new HealthController(prisma as never);

    expect(controller.health()).toEqual({ status: "ok" });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("reports ready when the database answers", async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]) };
    const controller = new HealthController(prisma as never);
    const reply = makeReply();

    await controller.ready(reply as never);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({ status: "ready", checks: { database: "ok" } });
  });

  it("answers 503 without leaking the error when the database query fails", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432")),
    };
    const controller = new HealthController(prisma as never);
    const reply = makeReply();

    await controller.ready(reply as never);

    expect(reply.code).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      status: "not_ready",
      checks: { database: "error" },
    });
  });
});
