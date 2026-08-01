import { describe, expect, it, vi } from "vitest";
import { withOperatorTransaction } from "../db";
import { clearSourceConcurrency, resolveInfrastructureSources, tryAcquireSource } from "./repository";

vi.mock("../db", () => ({ withOperatorTransaction: vi.fn() }));

const source = {
  id: "source-a",
  hardConcurrency: 1,
};

describe("source concurrency", () => {
  it("releases capacity exactly once", () => {
    clearSourceConcurrency();
    const release = tryAcquireSource(source);
    expect(release).toBeTypeOf("function");
    expect(tryAcquireSource(source)).toBeNull();
    release?.();
    release?.();
    expect(tryAcquireSource(source)).toBeTypeOf("function");
  });

  it("does not resolve a Cloud source after its credential is revoked", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: "source-a", kind: "cloud", status: "active", health_status: "healthy",
        credential_id: "revoked-credential", encrypted_value: null, key_version: null, purpose: null,
        hard_concurrency: 1, request_timeout_ms: 120_000, response_buffer_max_bytes: 5_242_880,
      }] });
    vi.mocked(withOperatorTransaction).mockImplementation(async (fn) => fn({ query } as never));

    const sources = await resolveInfrastructureSources("account-a", "included", "a".repeat(64), "https://cloud.example");

    expect(sources).toEqual([]);
    expect(query.mock.calls[0][0]).toContain("c.status = 'valid' AND c.superseded_at IS NULL");
  });
});
