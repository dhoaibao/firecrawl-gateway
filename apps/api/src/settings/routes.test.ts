import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createSettingsRouter } from "./routes";
import type { GatewayConfig } from "../types";

const mockGetSetting = vi.hoisted(() => vi.fn());
const mockListSettings = vi.hoisted(() => vi.fn());
const mockSetSetting = vi.hoisted(() => vi.fn());

vi.mock("./service", () => ({
  getSetting: mockGetSetting,
  listSettings: mockListSettings,
  setSetting: mockSetSetting,
  VALID_ROUTE_MODES: ["self-hosted-first", "self-hosted-only", "cloud-first", "cloud-only"],
}));

function createApp() {
  const app = express();
  app.use(express.json());
  const config: GatewayConfig = {
    port: 8080,
    cloudBaseUrl: "https://api.firecrawl.dev",
    defaultRouteMode: "self-hosted-first",
    requestTimeoutMs: 120_000,
    logFile: "/tmp/test.log",
    maxBodyBytes: 5_242_880,
    authEnabled: true,
    databaseUrl: "postgresql://localhost/test",
    operatorDatabaseUrl: "postgresql://localhost/operator-test",
    sessionSecret: "secret",
    firecrawlKeysEncryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    adminEmail: "",
    adminPassword: "",
    trustProxy: false,
  };
  app.use("/settings", createSettingsRouter(config));
  return app;
}

describe("GET /settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists parsed settings", async () => {
    mockListSettings.mockResolvedValue([
      { key: "user_inactivity_suspend_days", value: "30", updated_at: new Date().toISOString() },
      { key: "firecrawl_api_keys", value: '["fc_key1"]', updated_at: new Date().toISOString() },
      { key: "default_route_mode", value: "cloud-first", updated_at: new Date().toISOString() },
    ]);
    const app = createApp();
    const res = await request(app).get("/settings").expect(200);
    expect(res.body.data).toEqual({
      user_inactivity_suspend_days: 30,
      firecrawl_api_keys: ["fc_key1"],
      default_route_mode: "cloud-first",
    });
  });
});

describe("PUT /settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves firecrawl_api_keys as json", async () => {
    mockSetSetting.mockImplementation(async (key: string, value: string) => ({
      key,
      value,
      updated_at: new Date().toISOString(),
    }));
    const app = createApp();
    const res = await request(app)
      .put("/settings")
      .send({ firecrawl_api_keys: ["fc_secret_key"] })
      .expect(200);
    expect(mockSetSetting).toHaveBeenCalledWith("firecrawl_api_keys", expect.stringMatching(/^enc:v1:/));
    expect(res.body.data.firecrawl_api_keys).toEqual(["fc_secret_key"]);
  });

  it("saves default_route_mode", async () => {
    mockSetSetting.mockImplementation(async (key: string, value: string) => ({
      key,
      value,
      updated_at: new Date().toISOString(),
    }));
    const app = createApp();
    const res = await request(app)
      .put("/settings")
      .send({ default_route_mode: "cloud-only" })
      .expect(200);
    expect(mockSetSetting).toHaveBeenCalledWith("default_route_mode", "cloud-only");
    expect(res.body.data.default_route_mode).toBe("cloud-only");
  });

  it("rejects invalid default_route_mode values", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/settings")
      .send({ default_route_mode: "invalid" })
      .expect(400);
    expect(res.body.error).toContain("default_route_mode must be one of");
  });

  it("rejects invalid setting keys", async () => {
    const app = createApp();
    const res = await request(app).put("/settings").send({ unknown_key: "value" }).expect(400);
    expect(res.body.error).toContain("Invalid setting key");
  });

  it("rejects firecrawl_api_keys that is not an array", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/settings")
      .send({ firecrawl_api_keys: "fc_key" })
      .expect(400);
    expect(res.body.error).toContain("must be an array");
  });

  it("rejects too many firecrawl_api_keys", async () => {
    const app = createApp();
    const keys = Array.from({ length: 11 }, (_, i) => `fc_key_${i}`);
    const res = await request(app)
      .put("/settings")
      .send({ firecrawl_api_keys: keys })
      .expect(400);
    expect(res.body.error).toContain("at most");
  });

  it("rejects firecrawl_api_keys with short or non-string entries", async () => {
    const app = createApp();
    const res = await request(app)
      .put("/settings")
      .send({ firecrawl_api_keys: ["fc_key", ""] })
      .expect(400);
    expect(res.body.error).toContain("at least");
  });
});

describe("GET /settings/credit-usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns credit usage for all configured keys", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["fc_key1","fc_key2"]', updated_at: new Date().toISOString() };
      }
      return null;
    });

    let activeRequests = 0;
    let maxConcurrentRequests = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      activeRequests++;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeRequests--;
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            remainingCredits: 1000,
            planCredits: 5000,
            billingPeriodStart: "2025-01-01T00:00:00Z",
            billingPeriodEnd: "2025-01-31T23:59:59Z",
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp();
    const res = await request(app).get("/settings/credit-usage").expect(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].remainingCredits).toBe(1000);
    expect(res.body.data[1].remainingCredits).toBe(1000);
    expect(maxConcurrentRequests).toBe(2);

    vi.unstubAllGlobals();
  });

  it("returns error details for failed credit usage fetch", async () => {
    mockGetSetting.mockImplementation(async (key: string) => {
      if (key === "firecrawl_api_keys") {
        return { key, value: '["fc_bad_key"]', updated_at: new Date().toISOString() };
      }
      return null;
    });

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = createApp();
    const res = await request(app).get("/settings/credit-usage").expect(200);
    expect(res.body.data[0].error).toContain("401");

    vi.unstubAllGlobals();
  });
});
