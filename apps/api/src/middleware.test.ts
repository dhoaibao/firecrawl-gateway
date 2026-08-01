import { describe, expect, it } from "vitest";
import { requestIdMiddleware } from "./middleware";

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
