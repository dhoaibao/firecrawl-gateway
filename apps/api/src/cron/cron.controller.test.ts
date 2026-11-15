import { describe, expect, it, vi } from "vitest";
import { CronController } from "./cron.controller";

function makeReply() {
  const reply = { code: vi.fn(), send: vi.fn((body: unknown) => body) };
  reply.code.mockReturnValue(reply);
  return reply;
}

describe("CronController", () => {
  it("answers 401 without running maintenance when the bearer is not authorized", async () => {
    const cron = { isAuthorized: vi.fn().mockReturnValue(false), runMaintenance: vi.fn() };
    const controller = new CronController(cron as never);
    const reply = makeReply();

    await controller.maintenance("Bearer wrong", reply as never);

    expect(cron.isAuthorized).toHaveBeenCalledWith("Bearer wrong");
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ success: false, error: "Unauthorized" });
    expect(cron.runMaintenance).not.toHaveBeenCalled();
  });

  it("passes a missing authorization header to the service, which decides", async () => {
    const cron = { isAuthorized: vi.fn().mockReturnValue(false), runMaintenance: vi.fn() };
    const controller = new CronController(cron as never);

    await controller.maintenance(undefined, makeReply() as never);

    expect(cron.isAuthorized).toHaveBeenCalledWith(undefined);
    expect(cron.runMaintenance).not.toHaveBeenCalled();
  });

  it("runs maintenance and returns its result when authorized", async () => {
    const result = { prunedAuditLogs: 3 };
    const cron = {
      isAuthorized: vi.fn().mockReturnValue(true),
      runMaintenance: vi.fn().mockResolvedValue(result),
    };
    const controller = new CronController(cron as never);
    const reply = makeReply();

    await controller.maintenance("Bearer right", reply as never);

    expect(cron.runMaintenance).toHaveBeenCalledTimes(1);
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).toHaveBeenCalledWith({ success: true, data: result });
  });
});
