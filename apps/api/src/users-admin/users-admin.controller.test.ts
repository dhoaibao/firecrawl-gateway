import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { UserAdminError } from "./users-admin.service";
import { UsersAdminController } from "./users-admin.controller";

async function status(promise: Promise<unknown>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

function make() {
  const service = {
    list: vi.fn().mockResolvedValue({ total: 0, users: [] }),
    get: vi.fn().mockResolvedValue({ id: "u1" }),
    update: vi.fn().mockResolvedValue({ id: "u1" }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { service, controller: new UsersAdminController(service as never) };
}

describe("UsersAdminController", () => {
  it("lists with defaults and validates the filters", async () => {
    const { controller, service } = make();

    await controller.list({});
    expect(service.list).toHaveBeenCalledWith({
      search: undefined,
      state: "active",
      limit: 25,
      offset: 0,
    });

    for (const query of [
      { state: "banned" },
      { limit: "0" },
      { limit: "101" },
      { offset: "-1" },
      { limit: "abc" },
      { search: "x".repeat(201) },
    ])
      expect(await status(controller.list(query))).toBe(400);
  });

  it("validates a patch before touching anything", async () => {
    const { controller, service } = make();

    for (const body of [
      undefined,
      {},
      { status: "banned" },
      { rate_limit_per_minute: 0 },
      { rate_limit_per_minute: 1.5 },
      { max_api_keys: 1001 },
      { monthly_quota: "10" },
    ])
      expect(await status(controller.update("u1", body as never))).toBe(400);
    expect(service.update).not.toHaveBeenCalled();

    await controller.update("u1", { status: "suspended", max_api_keys: null, monthly_quota: 50 });
    expect(service.update).toHaveBeenCalledWith("u1", {
      status: "suspended",
      maxApiKeys: null,
      rateLimitPerMinute: undefined,
      monthlyQuota: 50,
    });
  });

  it("maps unknown and deleted users to 404 and 409", async () => {
    const { controller, service } = make();
    service.get.mockRejectedValueOnce(new UserAdminError("not_found"));
    expect(await status(controller.get("x"))).toBe(404);
    service.remove.mockRejectedValueOnce(new UserAdminError("deleted"));
    expect(await status(controller.remove("u1"))).toBe(409);
    service.update.mockRejectedValueOnce(new Error("database down"));
    await expect(controller.update("u1", { status: "active" })).rejects.toThrow("database down");
  });
});
