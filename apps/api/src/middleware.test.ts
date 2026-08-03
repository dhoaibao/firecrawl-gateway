import { describe, expect, it } from "vitest";
import { rateLimiter, requestIdMiddleware } from "./middleware";

interface TestRequest {
  headers: Record<string, string>;
  requestId?: string;
  quotaRequestId?: string;
}

describe("requestIdMiddleware", () => {
  it("keeps client correlation separate from the server-owned quota id", () => {
    const first: TestRequest = { headers: { "x-request-id": "client-replay" } };
    const second: TestRequest = { headers: { "x-request-id": "client-replay" } };
    const next = () => undefined;

    requestIdMiddleware(first as never, {} as never, next);
    requestIdMiddleware(second as never, {} as never, next);

    expect(first.requestId).toBe("client-replay");
    expect(second.requestId).toBe("client-replay");
    expect(first.quotaRequestId).toBeTruthy();
    expect(second.quotaRequestId).toBeTruthy();
    expect(first.quotaRequestId).not.toBe(second.quotaRequestId);
  });
});

describe("rateLimiter", () => {
  it("delegates scoped identities to the distributed store and emits retry metadata", async () => {
    const consume = async (keys: string[]) => {
      expect(keys).toEqual(expect.arrayContaining([
        "gateway:ip:10.0.0.1",
        "gateway:account:account-1",
        expect.stringMatching(/^gateway:token:/),
      ]));
      return { allowed: false, remaining: 0, resetAt: new Date(Date.now() + 10_000) };
    };
    const headers = new Map<string, string>();
    const res = {
      setHeader: (name: string, value: string) => headers.set(name, value),
      status: () => res,
      json: () => res,
    } as never;
    const req = {
      path: "/v1/scrape",
      method: "POST",
      headers: { authorization: "Bearer token-fingerprint" },
      socket: { remoteAddress: "10.0.0.1" },
      user: { id: "user-1", account_id: "account-1" },
    } as never;
    const next = () => { throw new Error("rate-limited request must not continue"); };

    rateLimiter(false, { consume })(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(headers.get("Retry-After")).toBeTruthy();
    expect(headers.get("X-RateLimit-Remaining")).toBe("0");
  });
});
