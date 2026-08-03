import { describe, expect, it } from "vitest";
import { encryptProviderCredential } from "../../credentials/domain/credential-crypto";
import { InfrastructureService } from "./infrastructure.service";

const key = "a".repeat(64);
const config = { cloudBaseUrl: "https://cloud.example", providerCredentialsEncryptionKey: key };

describe("InfrastructureService.resolve", () => {
  it("resolves valid account BYOK credentials with bound encryption context", async () => {
    const credential = { id: "credential-1", purpose: "firecrawl_cloud", encryptedValue: encryptProviderCredential("fc_cloud", key, { purpose: "firecrawl_cloud", ownerId: "account-1", sourceId: "account:account-1:credential-1", keyVersion: 1 }), keyVersion: 1, status: "valid", supersededAt: null, createdAt: new Date() };
    const transactions = { runAsOperator: (callback: (tx: unknown) => unknown) => callback({ providerCredential: { findMany: async () => [credential] }, infrastructureSource: { findMany: async () => [] } }) };
    const result = await new InfrastructureService(transactions as never, config as never).resolve("account-1", "byok");
    expect(result).toEqual([expect.objectContaining({ id: "account:account-1:credential-1", credential: "fc_cloud", fundingType: "byok" })]);
  });

  it("skips invalid credentials and does not dispatch cloud sources without a secret", async () => {
    const transactions = { runAsOperator: (callback: (tx: unknown) => unknown) => callback({ providerCredential: { findMany: async () => [{ id: "bad", purpose: "firecrawl_cloud", encryptedValue: "invalid", keyVersion: 1, status: "valid", supersededAt: null, createdAt: new Date() }] }, infrastructureSource: { findMany: async () => [{ id: "cloud-source", kind: "cloud", baseUrl: "", credentialId: null, credential: null, hardConcurrency: 1, requestTimeoutMs: 10, responseBufferMaxBytes: 100 }] } }) };
    const result = await new InfrastructureService(transactions as never, config as never).resolve("account-1", "auto");
    expect(result).toEqual([]);
  });

  it("enforces source concurrency and idempotent release", () => {
    const service = new InfrastructureService({} as never, config as never);
    const source = { id: "source-1", hardConcurrency: 1 };
    const release = service.tryAcquire(source);
    expect(release).toBeTypeOf("function");
    expect(service.tryAcquire(source)).toBeNull();
    release?.();
    release?.();
    expect(service.tryAcquire(source)).toBeTypeOf("function");
  });
});
