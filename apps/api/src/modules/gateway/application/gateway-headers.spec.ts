import { describe, expect, it } from "vitest";
import { headersForPrivacyCheck, sanitizeHeaders } from "./gateway-headers";

describe("native gateway header policy", () => {
  it("removes hop-by-hop and virtual routing headers", () => {
    expect(sanitizeHeaders({ host: "internal", connection: "keep-alive", "x-firecrawl-route-mode": "cloud", "x-request-id": "req" }, "self-hosted")).toEqual({ "x-request-id": "req" });
  });

  it("keeps client authorization only for auth-disabled self-hosted traffic", () => {
    expect(sanitizeHeaders({ authorization: "Bearer client" }, "self-hosted", undefined, true)).toEqual({});
    expect(sanitizeHeaders({ authorization: "Bearer client" }, "self-hosted", undefined, false)).toEqual({ authorization: "Bearer client" });
    expect(sanitizeHeaders({ authorization: "Bearer virtual" }, "cloud", "cloud-key")).toEqual({ authorization: "Bearer cloud-key" });
  });

  it("removes authorization before privacy inspection without mutating input", () => {
    const input = { Authorization: "Bearer secret", "x-test": "ok" };
    expect(headersForPrivacyCheck(input, true)).toEqual({ "x-test": "ok" });
    expect(input.Authorization).toBe("Bearer secret");
    expect(headersForPrivacyCheck(input, false)).toBe(input);
  });
});
