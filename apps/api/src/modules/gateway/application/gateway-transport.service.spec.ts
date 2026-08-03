import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayTransportService } from "./gateway-transport.service";

afterEach(() => vi.unstubAllGlobals());

describe("GatewayTransportService", () => {
  it("streams successful responses without buffering", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("streamed", { status: 200, headers: { "content-type": "text/plain" } })));
    const result = await new GatewayTransportService().execute({ backend: "self-hosted", targetUrl: "http://backend/v1/scrape", method: "POST", headers: { authorization: "Bearer virtual" }, body: Buffer.from("{}"), authEnabled: true, timeoutMs: 1_000, responseBufferMaxBytes: 100 });
    expect(result.kind).toBe("response");
    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    result.cleanup?.();
  });

  it("buffers bounded responses and rejects oversized bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("small", { status: 200 })));
    const small = await new GatewayTransportService().execute({ backend: "cloud", targetUrl: "http://backend/v1/scrape", method: "GET", headers: {}, apiKey: "cloud-key", authEnabled: true, timeoutMs: 1_000, responseBufferMaxBytes: 100, bufferSuccess: true });
    expect(small.body?.toString()).toBe("small");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("too-large", { status: 200 })));
    const large = await new GatewayTransportService().execute({ backend: "cloud", targetUrl: "http://backend/v1/scrape", method: "GET", headers: {}, authEnabled: true, timeoutMs: 1_000, responseBufferMaxBytes: 3, bufferSuccess: true });
    expect(large).toMatchObject({ kind: "network-error", statusCode: 502 });
  });

  it("converts upstream failures and aborts from the client", async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new GatewayTransportService().execute({ backend: "self-hosted", targetUrl: "http://backend/v1/scrape", method: "GET", headers: {}, authEnabled: false, timeoutMs: 1_000, responseBufferMaxBytes: 100 });
    expect(result).toMatchObject({ kind: "network-error", statusCode: 502 });
    expect(result.body?.toString()).toContain("Gateway upstream timeout");
  });
});
