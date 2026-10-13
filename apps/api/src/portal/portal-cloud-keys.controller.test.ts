import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { UserCloudKeyError } from "../user-cloud-keys/user-cloud-keys.service";
import { PortalCloudKeysController } from "./portal-cloud-keys.controller";

const request = { user: { id: "user-1" } } as never;
const KEY = "fc-0123456789abcdef";

async function status(promise: Promise<unknown>) {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

function make(overrides: Record<string, unknown> = {}) {
  const service = {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({ key: { id: "k1" }, status: { status: "valid" } }),
    update: vi.fn().mockResolvedValue({ id: "k1" }),
    verify: vi.fn().mockResolvedValue({ status: "valid" }),
    remove: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  return { service, controller: new PortalCloudKeysController(service as never) };
}

describe("PortalCloudKeysController", () => {
  it("adds a key for the signed-in user only, trimming it and defaulting the role", async () => {
    const { service, controller } = make();

    await controller.add(request, { name: " Main ", key: `  ${KEY}  ` });

    expect(service.add).toHaveBeenCalledWith("user-1", { name: "Main", key: KEY, role: "cloud" });
  });

  it("rejects malformed keys, roles and names before calling anything", async () => {
    const { service, controller } = make();

    expect(await status(controller.add(request, { name: "n", key: "short" }))).toBe(400);
    expect(await status(controller.add(request, { name: "n", key: "has space inside" }))).toBe(400);
    expect(await status(controller.add(request, { name: "n", key: KEY, role: "admin" }))).toBe(400);
    expect(await status(controller.add(request, { key: KEY }))).toBe(400);
    expect(await status(controller.update(request, "k1", {}))).toBe(400);
    expect(service.add).not.toHaveBeenCalled();
  });

  it.each([
    ["limit_reached", 409],
    ["duplicate", 409],
    ["invalid_key", 400],
    ["unverifiable", 502],
    ["verify_too_soon", 429],
    ["unreadable", 409],
  ] as const)("maps %s to HTTP %i without echoing the key", async (reason, expected) => {
    const { controller } = make({
      add: vi.fn().mockRejectedValue(new UserCloudKeyError(reason)),
      verify: vi.fn().mockRejectedValue(new UserCloudKeyError(reason)),
    });

    expect(await status(controller.add(request, { name: "n", key: KEY }))).toBe(expected);
    expect(await status(controller.verify(request, "k1"))).toBe(expected);
    try {
      await controller.add(request, { name: "n", key: KEY });
    } catch (error) {
      expect(JSON.stringify((error as HttpException).getResponse())).not.toContain(KEY);
    }
  });

  it("answers 404 for keys that are not the caller's and passes unknown errors through", async () => {
    const { controller, service } = make({
      update: vi.fn().mockResolvedValue(null),
      verify: vi.fn().mockResolvedValue(null),
      remove: vi.fn().mockResolvedValue(false),
    });

    expect(await status(controller.update(request, "x", { name: "n" }))).toBe(404);
    expect(await status(controller.verify(request, "x"))).toBe(404);
    expect(await status(controller.remove(request, "x"))).toBe(404);
    expect(service.remove).toHaveBeenCalledWith("user-1", "x");

    service.verify.mockRejectedValueOnce(new Error("database down"));
    await expect(controller.verify(request, "k1")).rejects.toThrow("database down");
  });
});
