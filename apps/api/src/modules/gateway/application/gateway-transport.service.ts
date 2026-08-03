import { Injectable } from "@nestjs/common";
import { sanitizeHeaders } from "./gateway-headers";

export type GatewayTransportResult = { kind: "response" | "network-error"; backend: string; response?: Response; stream?: ReadableStream<Uint8Array>; body?: Buffer; error?: Error; statusCode?: number; durationMs: number; cleanup?: () => void; };
export interface GatewayTransportInput { backend: string; targetUrl: string; method: string; headers: Record<string, string | string[] | undefined>; body?: Buffer; apiKey?: string; authEnabled: boolean; timeoutMs: number; responseBufferMaxBytes: number; bufferSuccess?: boolean; successBufferMaxBytes?: number; requestSignal?: AbortSignal; }

@Injectable()
export class GatewayTransportService {
  async execute(input: GatewayTransportInput): Promise<GatewayTransportResult> {
    const controller = new AbortController();
    const started = Date.now();
    const abortRequest = () => controller.abort();
    input.requestSignal?.addEventListener("abort", abortRequest, { once: true });
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    let streamed = false;
    try {
      const response = await fetch(input.targetUrl, { method: input.method, headers: sanitizeHeaders(input.headers, input.backend, input.apiKey, input.authEnabled), body: input.method === "GET" || input.method === "HEAD" ? undefined : input.body, redirect: "manual", signal: controller.signal });
      const successful = response.ok || response.status < 400;
      const contentLength = Number(response.headers.get("content-length"));
      const boundedSuccess = input.successBufferMaxBytes !== undefined && Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength <= input.successBufferMaxBytes;
      if (successful && response.body && !input.bufferSuccess && !boundedSuccess) { streamed = true; return { kind: "response", backend: input.backend, response, stream: response.body, durationMs: Date.now() - started, cleanup: () => this.cleanup(timeout, input.requestSignal, abortRequest) }; }
      const limit = boundedSuccess ? Math.min(input.successBufferMaxBytes!, input.responseBufferMaxBytes) : input.responseBufferMaxBytes;
      const body = await readBoundedResponseBody(response, limit);
      if (body === null) return this.networkError(input.backend, "Upstream response exceeds the gateway buffer limit", Date.now() - started, true);
      return { kind: "response", backend: input.backend, response, body, durationMs: Date.now() - started };
    } catch (error) {
      const reason = (error as Error).name === "AbortError" ? "Gateway upstream timeout" : (error as Error).message;
      return this.networkError(input.backend, reason, Date.now() - started, true);
    } finally {
      if (!streamed) this.cleanup(timeout, input.requestSignal, abortRequest);
    }
  }

  private cleanup(timeout: NodeJS.Timeout, requestSignal: AbortSignal | undefined, listener: () => void) { clearTimeout(timeout); requestSignal?.removeEventListener("abort", listener); }
  private networkError(backend: string, message: string, durationMs: number, dispatched: boolean): GatewayTransportResult { return { kind: "network-error", backend, error: new Error(message), body: Buffer.from(JSON.stringify({ success: false, error: message })), statusCode: 502, durationMs, ...(dispatched ? {} : {}) }; }
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<Buffer | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength >= 0 && contentLength > maxBytes) { if (response.body) await response.body.cancel().catch(() => undefined); return null; }
  if (!response.body) { const body = Buffer.from(await response.arrayBuffer()); return body.length <= maxBytes ? body : null; }
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) return Buffer.concat(chunks, total); const chunk = Buffer.from(value); total += chunk.length; if (total > maxBytes) { await reader.cancel().catch(() => undefined); return null; } chunks.push(chunk); } } finally { reader.releaseLock(); }
}
