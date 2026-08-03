import { describe, expect, it } from "vitest";
import { requestMetadata } from "./request-context";

describe("request context", () => {
  it("normalizes request metadata without depending on Express types", () => {
    expect(requestMetadata({
      id: "fastify-id",
      requestId: "client-id",
      ip: "192.0.2.10",
      headers: { "user-agent": ["native-client", "ignored"] },
    })).toEqual({
      requestId: "client-id",
      clientIp: "192.0.2.10",
      userAgent: "native-client",
    });
  });

  it("falls back to the Fastify request id", () => {
    expect(requestMetadata({
      id: "fastify-id",
      ip: "127.0.0.1",
      headers: {},
    })).toEqual({
      requestId: "fastify-id",
      clientIp: "127.0.0.1",
      userAgent: undefined,
    });
  });
});
