import type { FastifyRequest } from "fastify";

export interface AdminIdentity {
  email: string;
}

export interface AuditEntry {
  id: string;
  created_at: string;
  method: string;
  path: string;
  route_mode: string;
  backend_used: string;
  fallback_used: boolean;
  fallback_reason: string;
  status_code: number;
  duration_ms: number;
  target_url: string;
  request_id?: string;
  /** Virtual API key that made the request; absent for playground and rejected requests. */
  api_key_id?: string;
  /** Portal user who owns the key that made the request; absent for global keys. */
  user_id?: string;
}

export type Backend = "cloud" | "self-hosted";

/** `cloud` keys serve Cloud traffic; `fallback` keys only back up self-hosted in hybrid mode. */
export type CloudKeyRole = "cloud" | "fallback";

export interface CloudKeyEntry {
  key: string;
  role: CloudKeyRole;
}

export interface ProxyResult {
  kind: "response" | "network-error";
  backend: Backend;
  response?: Response;
  error?: Error;
  body?: Buffer;
  stream?: ReadableStream<Uint8Array>;
  cleanup?: () => void;
  durationMs: number;
}

export interface RequestWithContext extends FastifyRequest {
  requestId: string;
  admin?: AdminIdentity;
  rawBody?: Buffer | string;
}

export interface NeedsCloudResult {
  required: boolean;
  reason: string;
}
