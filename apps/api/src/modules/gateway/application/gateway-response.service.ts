import { Readable } from "node:stream";
import { Injectable } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { GatewayTransportResult } from "./gateway-transport.service";
import type { QuotaReservation } from "../../quota/application/quota.service";

const hopByHopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

@Injectable()
export class GatewayResponseService {
  async send(reply: FastifyReply, result: GatewayTransportResult, meta: { fallbackUsed?: boolean; fallbackReason?: string; fundingType?: string; quota?: QuotaReservation | null }): Promise<void> {
    const headers: Record<string, string> = { "x-hybrid-firecrawl-backend": result.backend, "x-hybrid-firecrawl-fallback": String(meta.fallbackUsed ?? false) };
    if (meta.quota) { headers["x-quota-limit"] = String(meta.quota.limit); headers["x-quota-remaining"] = String(meta.quota.remaining); headers["x-quota-reset"] = meta.quota.resetAt; }
    if (meta.fundingType) headers["x-hybrid-firecrawl-funding"] = meta.fundingType;
    if (meta.fallbackReason) headers["x-hybrid-firecrawl-fallback-reason"] = meta.fallbackReason;
    if (result.kind === "network-error") { reply.status(result.statusCode ?? 502).headers({ ...headers, "content-type": "application/json; charset=utf-8" }).send(result.body); return; }
    result.response?.headers.forEach((value, key) => { const lower = key.toLowerCase(); if (hopByHopHeaders.has(lower) || (!result.stream && lower === "content-encoding")) return; headers[key] = value; });
    if (!result.stream && result.body) headers["content-length"] = String(result.body.length);
    if (!result.stream) { reply.status(result.response?.status ?? 502).headers(headers).send(result.body); return; }
    reply.hijack();
    reply.raw.writeHead(result.response?.status ?? 502, headers);
    await new Promise<void>((resolve, reject) => { const stream = Readable.fromWeb(result.stream as ReadableStream<Uint8Array>); stream.once("error", reject).once("end", resolve); reply.raw.once("close", resolve).once("error", reject); stream.pipe(reply.raw); }).finally(() => result.cleanup?.());
  }
}
