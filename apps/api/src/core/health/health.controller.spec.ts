import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller";
import type { HealthService } from "./health.service";

function createController(databaseReady: boolean): HealthController {
  const health = {
    isDatabaseReady: vi.fn().mockResolvedValue(databaseReady),
  } as unknown as HealthService;
  return new HealthController(health);
}

describe("HealthController", () => {
  it("reports process health without touching the database", () => {
    expect(createController(false).checkHealth()).toEqual({ status: "ok" });
  });

  it("reports database readiness", async () => {
    await expect(createController(true).checkReadiness()).resolves.toEqual({
      status: "ready",
      checks: { database: "ok" },
    });
  });

  it("fails readiness when the database cannot be reached", async () => {
    await expect(createController(false).checkReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
