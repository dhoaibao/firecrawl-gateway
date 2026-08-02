import bcrypt from "bcrypt";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createCredentialsRouter } from "./routes";
import type { GatewayConfig, User } from "../types";

const config: GatewayConfig = {
  port: 8080,
  cloudBaseUrl: "https://api.firecrawl.dev",
  defaultRouteMode: "cloud-first",
  requestTimeoutMs: 120_000,
  logFile: "",
  maxBodyBytes: 5_242_880,
  authEnabled: true,
  databaseUrl: "postgresql://localhost/test",
  operatorDatabaseUrl: "postgresql://localhost/operator-test",
  sessionSecret: "test",
  firecrawlKeysEncryptionKey: "a".repeat(64),
  providerCredentialsEncryptionKey: "b".repeat(64),
  adminEmail: "",
  adminPassword: "",
  trustProxy: false,
};

const credential = {
  id: "credential-a",
  owner_type: "account" as const,
  account_id: "account-a",
  purpose: "firecrawl_cloud" as const,
  key_version: 1,
  masked_prefix: "fc_",
  masked_suffix: "1234",
  status: "valid" as const,
  provider_metadata: {},
  last_validated_at: null,
  last_used_at: null,
  superseded_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

function appFor(user: Partial<User>, dependencies: Parameters<typeof createCredentialsRouter>[1]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user as User;
    next();
  });
  app.use("/credentials", createCredentialsRouter(config, dependencies));
  return app;
}

describe("credentials routes", () => {
  it("creates and immediately validates an account Cloud credential without returning its value", async () => {
    const createAccountCredential = vi.fn().mockResolvedValue({ ...credential, status: "pending" });
    const validateAccountCredential = vi.fn().mockResolvedValue(credential);
    const response = await request(appFor(
      { id: "user-a", account_id: "account-a", email_verified_at: "2026-01-01", password_hash: bcrypt.hashSync("current-password", 4) },
      { createAccountCredential, listAccountCredentialMetadata: vi.fn(), validateAccountCredential },
    )).post("/credentials").send({ value: "fc_provider_secret", current_password: "current-password" });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(credential);
    expect(response.text).not.toContain("fc_provider_secret");
    expect(validateAccountCredential).toHaveBeenCalledWith("account-a", "credential-a", "b".repeat(64), config.cloudBaseUrl);
  });

  it("allows a credential to be explicitly revalidated", async () => {
    const validateAccountCredential = vi.fn().mockResolvedValue(credential);
    const response = await request(appFor(
      { id: "user-a", account_id: "account-a", password_hash: bcrypt.hashSync("current-password", 4) },
      { createAccountCredential: vi.fn(), listAccountCredentialMetadata: vi.fn(), validateAccountCredential },
    )).post("/credentials/credential-a/validate").send({ current_password: "current-password" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(credential);
    expect(validateAccountCredential).toHaveBeenCalledWith("account-a", "credential-a", "b".repeat(64), config.cloudBaseUrl);
  });
});
