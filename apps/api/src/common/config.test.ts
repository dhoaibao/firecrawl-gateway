import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://localhost/firecrawl",
  FIRECRAWL_KEYS_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "correct-password",
  SESSION_SECRET: "session-secret",
};

describe("loadConfig", () => {
  it.each([undefined, "", "   "])(
    "requires SESSION_SECRET when authentication is enabled (%j)",
    (sessionSecret) => {
      expect(() => loadConfig({ ...baseEnv, SESSION_SECRET: sessionSecret })).toThrow(
        /SESSION_SECRET is required/,
      );
    },
  );

  it("loads an authenticated configuration with a session secret", () => {
    expect(loadConfig(baseEnv).sessionSecret).toBe("session-secret");
  });

  it("reads SESSION_SECURE and leaves it undefined when unset or unrecognized", () => {
    expect(loadConfig(baseEnv).sessionSecure).toBeUndefined();
    expect(loadConfig({ ...baseEnv, SESSION_SECURE: "maybe" }).sessionSecure).toBeUndefined();
    expect(loadConfig({ ...baseEnv, SESSION_SECURE: "true" }).sessionSecure).toBe(true);
    expect(loadConfig({ ...baseEnv, SESSION_SECURE: "OFF" }).sessionSecure).toBe(false);
  });

  it("accepts an optional Redis TCP URL", () => {
    expect(loadConfig({ ...baseEnv, REDIS_URL: "redis://localhost:6379" }).redisUrl).toBe(
      "redis://localhost:6379",
    );
    expect(loadConfig(baseEnv).redisUrl).toBe("");
  });

  it("leaves the metrics endpoint disabled unless a sufficiently long METRICS_TOKEN is set", () => {
    expect(loadConfig(baseEnv).metricsToken).toBe("");
    expect(loadConfig({ ...baseEnv, METRICS_TOKEN: "0123456789abcdef" }).metricsToken).toBe(
      "0123456789abcdef",
    );
    expect(() => loadConfig({ ...baseEnv, METRICS_TOKEN: "short" })).toThrow(/METRICS_TOKEN/);
  });

  it("defaults the self-hosted Firecrawl to the Compose stack and trims trailing slashes", () => {
    expect(loadConfig(baseEnv).selfHostedBaseUrl).toBe("http://127.0.0.1:3002");
    expect(
      loadConfig({ ...baseEnv, FIRECRAWL_SELF_HOSTED_URL: "http://firecrawl:3002/" })
        .selfHostedBaseUrl,
    ).toBe("http://firecrawl:3002");
  });

  it("allows an empty session secret when authentication is disabled", () => {
    const config = loadConfig({ AUTH_ENABLED: "false", ...baseEnv, SESSION_SECRET: undefined });

    expect(config.authEnabled).toBe(false);
    expect(config.sessionSecret).toBe("");
  });
});
