import { describe, expect, it, vi } from "vitest";
import { GatewayController } from "./gateway.controller";

function createController(transportResult: Record<string, unknown>) {
  const release = vi.fn();
  const infrastructure = {
    tryAcquire: vi.fn().mockReturnValue(release),
    touchCredential: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new GatewayController(
    { authEnabled: true } as never,
    {} as never,
    infrastructure as never,
    {} as never,
    {} as never,
    { execute: vi.fn().mockResolvedValue(transportResult) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, infrastructure, release };
}

describe("GatewayController native dispatch", () => {
  it("touches BYOK credentials and releases source capacity after a buffered response", async () => {
    const { controller, infrastructure, release } = createController({
      kind: "response",
      backend: "self-hosted",
      response: new Response("ok", { status: 200 }),
      body: Buffer.from("ok"),
      durationMs: 1,
    });
    const source = {
      id: "account:source-1",
      kind: "self_hosted",
      baseUrl: "http://self-hosted",
      credential: "secret-not-logged",
      credentialId: "credential-1",
      fundingType: "byok",
      hardConcurrency: 2,
      requestTimeoutMs: 1000,
      responseBufferMaxBytes: 100,
    };

    await (controller as any).dispatch(
      { method: "POST", headers: {}, body: { url: "https://example.com" } },
      source,
      "/v1/scrape",
      { url: "https://example.com" },
      null,
      "account-1",
      "request-1",
      new AbortController().signal,
    );

    expect(infrastructure.touchCredential).toHaveBeenCalledWith("account-1", "credential-1");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("leases streaming source capacity until response cleanup", async () => {
    const cleanup = vi.fn();
    const { controller, release } = createController({
      kind: "response",
      backend: "cloud",
      response: new Response(null, { status: 200 }),
      stream: { on: vi.fn() },
      cleanup,
      durationMs: 1,
    });
    const source = {
      id: "cloud",
      kind: "cloud",
      baseUrl: "https://cloud",
      fundingType: "included",
      hardConcurrency: 2,
      requestTimeoutMs: 1000,
      responseBufferMaxBytes: 100,
    };

    const result = await (controller as any).dispatch(
      { method: "GET", headers: {}, body: undefined },
      source,
      "/v1/scrape",
      undefined,
      null,
      undefined,
      "request-2",
      new AbortController().signal,
    );

    expect(release).not.toHaveBeenCalled();
    result.result.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
