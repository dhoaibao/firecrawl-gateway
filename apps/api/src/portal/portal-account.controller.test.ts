import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PortalAccountController } from "./portal-account.controller";

const request = { user: { id: "user-1", email: "a@b.c" } } as never;

function make() {
  const users = { listIdentities: vi.fn().mockResolvedValue([{ provider: "github" }]) };
  const keys = {
    listUserApiKeys: vi.fn().mockResolvedValue([
      { id: "k1", name: "CI", key_prefix: "fc_aaaaaa" },
      { id: "k2", name: "Idle", key_prefix: "fc_bbbbbb" },
    ]),
  };
  const audit = {
    readApiKeyUsage: vi.fn().mockResolvedValue([
      {
        api_key_id: "k1",
        total: 10,
        error_count: 2,
        fallbacks: 0,
        avg_duration_ms: 200,
        last_request_at: "2026-10-12T00:00:00.000Z",
      },
      // Another user's key can never be in the filtered result, but would be ignored anyway.
      { api_key_id: "other", total: 99, error_count: 0, fallbacks: 0, avg_duration_ms: 1 },
    ]),
  };
  const controller = new PortalAccountController(users as never, keys as never, audit as never);
  return { controller, users, keys, audit };
}

describe("PortalAccountController", () => {
  it("returns the user with their linked sign-in methods", async () => {
    const { controller, users } = make();
    await expect(controller.account(request)).resolves.toEqual({
      data: { user: { id: "user-1", email: "a@b.c" }, identities: [{ provider: "github" }] },
    });
    expect(users.listIdentities).toHaveBeenCalledWith("user-1");
  });

  it("aggregates usage over the user's own keys only", async () => {
    const { controller, audit } = make();

    const { data } = await controller.usage(request, { range: "week", tz: "Asia/Ho_Chi_Minh" });

    expect(audit.readApiKeyUsage).toHaveBeenCalledWith({
      apiKeyIds: ["k1", "k2"],
      range: "week",
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(data.total).toBe(10);
    expect(data.error_count).toBe(2);
    expect(data.avg_duration_ms).toBe(200);
    expect(data.keys).toEqual([
      expect.objectContaining({ api_key_id: "k1", name: "CI", total: 10 }),
      expect.objectContaining({ api_key_id: "k2", name: "Idle", total: 0, last_request_at: null }),
    ]);
  });

  it("defaults to the current month and rejects an unknown range or time zone", async () => {
    const { controller, audit } = make();
    await controller.usage(request, {});
    expect(audit.readApiKeyUsage).toHaveBeenCalledWith(expect.objectContaining({ range: "month" }));

    for (const query of [{ range: "custom" }, { range: "decade" }, { tz: "Not/AZone" }]) {
      await expect(controller.usage(request, query)).rejects.toBeInstanceOf(HttpException);
    }
  });
});
