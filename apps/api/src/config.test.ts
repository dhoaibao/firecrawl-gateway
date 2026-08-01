import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("config parsing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function loadConfigWithEnv(env: Record<string, string | undefined>) {
    process.env.FIRECRAWL_KEYS_ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    const mod = await import("./config");
    return mod.parseConfig(process.env);
  }

  it.each([
    ["false", false],
    ["0", false],
    ["no", false],
    ["off", false],
    ["", false],
    ["true", true],
    ["1", true],
    ["yes", true],
    ["on", true],
  ] as const)("parses AUTH_ENABLED=%s as %s", async (value, expected) => {
    const config = await loadConfigWithEnv({
      AUTH_ENABLED: value,
      DATABASE_URL: "postgresql://localhost/test",
      OPERATOR_DATABASE_URL: "postgresql://localhost/operator-test",
    });
    expect(config.authEnabled).toBe(expected);
  });

  it.each([
    ["false", false],
    ["0", false],
    ["true", true],
    ["1", true],
    ["loopback, 10.0.0.0/8", "loopback, 10.0.0.0/8"],
  ] as const)("parses TRUST_PROXY=%s as %s", async (value, expected) => {
    const config = await loadConfigWithEnv({
      TRUST_PROXY: value,
      DATABASE_URL: "postgresql://localhost/test",
      OPERATOR_DATABASE_URL: "postgresql://localhost/operator-test",
    });
    expect(config.trustProxy).toBe(expected);
  });

  it("requires a canonical public URL for production authentication", async () => {
    await expect(loadConfigWithEnv({
      NODE_ENV: "production",
      AUTH_ENABLED: "true",
      SESSION_SECRET: "a".repeat(32),
      AUTH_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_APP_URL: undefined,
      DATABASE_URL: "postgresql://localhost/test",
      OPERATOR_DATABASE_URL: "postgresql://localhost/operator-test",
    })).rejects.toThrow("PUBLIC_APP_URL is required");
  });

  it("uses defaults when env vars are absent", async () => {
    const config = await loadConfigWithEnv({
      DATABASE_URL: "postgresql://localhost/test",
      OPERATOR_DATABASE_URL: "postgresql://localhost/operator-test",
      AUTH_ENABLED: undefined,
      TRUST_PROXY: undefined,
    });
    expect(config.authEnabled).toBe(true);
    expect(config.trustProxy).toBe(false);
    expect(config.port).toBe(8080);
    expect(config.defaultRouteMode).toBe("cloud-first");
  });
});
