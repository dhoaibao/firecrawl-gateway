import { describe, expect, it } from "vitest";
import { validateEnvironment } from "./environment.schema";

const databaseEnvironment = {
  DATABASE_URL: "postgresql://localhost/firecrawl",
  OPERATOR_DATABASE_URL: "postgresql://localhost/firecrawl_operator",
};

describe("validateEnvironment", () => {
  it("builds a separate runtime/operator configuration with safe defaults", () => {
    expect(validateEnvironment(databaseEnvironment)).toEqual({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      PORT: 8080,
      DATABASE_URL: "postgresql://localhost/firecrawl",
      OPERATOR_DATABASE_URL: "postgresql://localhost/firecrawl_operator",
      TRUST_PROXY: false,
      AUTH_ENABLED: true,
      REGISTRATION_ENABLED: true,
      ADMIN_EMAIL: "",
      ADMIN_PASSWORD: "",
      SESSION_SECRET: "development-only-session-secret-change-me",
      SESSION_SECURE: "auto",
      AUTH_ENCRYPTION_KEY: "0".repeat(64),
      PROVIDER_CREDENTIALS_ENCRYPTION_KEY: "0".repeat(64),
      CLOUD_BASE_URL: "https://api.firecrawl.dev",
      BREVO_API_KEY: "",
      BREVO_SENDER_EMAIL: "noreply@example.com",
      BREVO_SENDER_NAME: "Firecrawl Gateway",
      BREVO_WEBHOOK_TOKEN: "",
      AUDIT_RETENTION_DAYS: 90,
      WORKER_HEARTBEAT_FILE: "/tmp/firecrawl-worker-heartbeat",
      PUBLIC_APP_URL: "http://localhost:3000",
      CORS_ORIGIN: "",
      BCRYPT_ROUNDS: 12,
    });
  });

  it("rejects absent database credentials", () => {
    expect(() => validateEnvironment({})).toThrow("DATABASE_URL is required");
    expect(() => validateEnvironment({ DATABASE_URL: databaseEnvironment.DATABASE_URL })).toThrow("OPERATOR_DATABASE_URL is required");
  });

  it("parses boolean proxy configuration", () => {
    expect(validateEnvironment({ ...databaseEnvironment, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
  });

  it("requires explicit authentication secrets in production", () => {
    expect(() => validateEnvironment({ NODE_ENV: "production", ...databaseEnvironment })).toThrow("SESSION_SECRET must be configured in production");
  });

  it("requires an explicit public application URL in production", () => {
    expect(() => validateEnvironment({
      NODE_ENV: "production",
      ...databaseEnvironment,
      SESSION_SECRET: "production-session-secret-that-is-at-least-32-characters",
      AUTH_ENCRYPTION_KEY: "a".repeat(64),
    })).toThrow("PUBLIC_APP_URL must be configured in production");
  });
});
