import { describe, expect, it } from "vitest";
import { validateEnvironment } from "./environment.schema";

describe("validateEnvironment", () => {
  it("builds a single-database configuration with safe defaults", () => {
    expect(validateEnvironment({ DATABASE_URL: "postgresql://localhost/firecrawl" })).toEqual({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      PORT: 8080,
      DATABASE_URL: "postgresql://localhost/firecrawl",
      TRUST_PROXY: false,
      AUTH_ENABLED: true,
      REGISTRATION_ENABLED: true,
      SESSION_SECRET: "development-only-session-secret-change-me",
      SESSION_SECURE: "auto",
      AUTH_ENCRYPTION_KEY: "0".repeat(64),
      PUBLIC_APP_URL: "http://localhost:3000",
      CORS_ORIGIN: "",
      BCRYPT_ROUNDS: 12,
    });
  });

  it("rejects an absent database URL", () => {
    expect(() => validateEnvironment({})).toThrow("DATABASE_URL is required");
  });

  it("parses boolean proxy configuration", () => {
    expect(validateEnvironment({
      DATABASE_URL: "postgresql://localhost/firecrawl",
      TRUST_PROXY: "true",
    }).TRUST_PROXY).toBe(true);
  });

  it("requires explicit authentication secrets in production", () => {
    expect(() => validateEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/firecrawl",
    })).toThrow("SESSION_SECRET must be configured in production");
  });

  it("requires an explicit public application URL in production", () => {
    expect(() => validateEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://localhost/firecrawl",
      SESSION_SECRET: "production-session-secret-that-is-at-least-32-characters",
      AUTH_ENCRYPTION_KEY: "a".repeat(64),
    })).toThrow("PUBLIC_APP_URL must be configured in production");
  });
});
