import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GatewayTransportService } from "./gateway-transport.service";

afterEach(() => vi.unstubAllGlobals());

let upstream: http.Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = http.createServer((request, response) => {
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("first-");
      setTimeout(() => response.end("second"), 5);
      return;
    }
    setTimeout(() => response.end("slow"), 200);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address() as { port: number };
  upstreamUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
});

describe("GatewayTransportService", () => {
  it("streams successful responses without buffering", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("streamed", { status: 200, headers: { "content-type": "text/plain" } })));
    const result = await new GatewayTransportService().execute({ backend: "self-hosted", targetUrl: "http://backend/v1/scrape", method: "POST", headers: { authorization: "Bearer virtual" }, body: Buffer.from("{}"), authEnabled: true, timeoutMs: 1_000, responseBufferMaxBytes: 100 });
    expect(result.kind).toBe("response");
    expect(result.stream).toBeDefined();
    expect(result.body).toBeUndefined();
    result.cleanup?.();
  });

  it("streams through a real local upstream without buffering", async () => {
    const result = await new GatewayTransportService().execute({ backend: "self-hosted", targetUrl: `${upstreamUrl}/stream`, method: "GET", headers: {}, authEnabled: false, timeoutMs: 1_000, responseBufferMaxBytes: 100 });
    expect(result.kind).toBe("response");
    expect(result.stream).toBeDefined();
    await expect(new Response(result.stream!).text()).resolves.toBe("first-second");
    result.cleanup?.();
  });

  it("aborts a real upstream request from the caller signal", async () => {
    const requestAbort = new AbortController();
    const promise = new GatewayTransportService().execute({ backend: "self-hosted", targetUrl: `${upstreamUrl}/slow`, method: "GET", headers: {}, authEnabled: false, timeoutMs: 1_000, responseBufferMaxBytes: 100, requestSignal: requestAbort.signal });
    setTimeout(() => requestAbort.abort(), 10);
    await expect(promise).resolves.toMatchObject({ kind: "network-error", statusCode: 502 });
  });

  it("converts a real upstream timeout into a bounded gateway error", async () => {
    const result = await new GatewayTransportService().execute({ backend: "self-hosted", targetUrl: `${upstreamUrl}/slow`, method: "GET", headers: {}, authEnabled: false, timeoutMs: 20, responseBufferMaxBytes: 100 });
    expect(result).toMatchObject({ kind: "network-error", statusCode: 502 });
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
    const requestAbort = new AbortController();
    requestAbort.abort();
    const result = await new GatewayTransportService().execute({ backend: "self-hosted", targetUrl: "http://backend/v1/scrape", method: "GET", headers: {}, authEnabled: false, timeoutMs: 1_000, responseBufferMaxBytes: 100, requestSignal: requestAbort.signal });
    expect(fetchMock).toHaveBeenCalledWith("http://backend/v1/scrape", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result).toMatchObject({ kind: "network-error", statusCode: 502 });
    expect(result.body?.toString()).toContain("Gateway upstream timeout");
  });
});
