import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDefaultRouteMode, clearSettingsCache } from "./service";

const state = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("../infrastructure/database", () => ({
  getPrisma: () => ({
    runtime: {
      setting: {
        findUnique: state.findUnique,
        findMany: state.findMany,
        upsert: state.upsert,
        deleteMany: state.deleteMany,
      },
    },
  }),
}));

describe("getDefaultRouteMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSettingsCache();
  });

  it("returns the stored value when valid", async () => {
    state.findUnique.mockResolvedValue({
      key: "default_route_mode",
      value: "cloud-first",
      updatedAt: new Date(),
    });
    const result = await getDefaultRouteMode("self-hosted-first");
    expect(result).toBe("cloud-first");
  });

  it("falls back when setting is missing", async () => {
    state.findUnique.mockResolvedValue(null);
    const result = await getDefaultRouteMode("self-hosted-first");
    expect(result).toBe("self-hosted-first");
  });

  it("falls back when stored value is invalid", async () => {
    state.findUnique.mockResolvedValue({
      key: "default_route_mode",
      value: "invalid",
      updatedAt: new Date(),
    });
    const result = await getDefaultRouteMode("self-hosted-only");
    expect(result).toBe("self-hosted-only");
  });
});
