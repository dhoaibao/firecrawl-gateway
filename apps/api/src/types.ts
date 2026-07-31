import type { RouteMode } from "./settings/service";

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
  user_id?: string;
  account_id?: string;
  request_id?: string;
}

export interface ProxyResult {
  kind: "response" | "network-error";
  backend: string;
  response?: Response;
  error?: Error;
  /** Buffered only for errors/fallback inspection; successful responses may stream. */
  body?: Buffer;
  stream?: ReadableStream<Uint8Array>;
  cleanup?: () => void;
  durationMs: number;
}

export interface GatewayConfig {
  port: number;
  cloudBaseUrl: string;
  defaultRouteMode: RouteMode;
  requestTimeoutMs: number;
  logFile: string;
  maxBodyBytes: number;
  authEnabled: boolean;
  databaseUrl: string;
  operatorDatabaseUrl: string;
  sessionSecret: string;
  firecrawlKeysEncryptionKey: string;
  adminEmail: string;
  adminPassword: string;
  trustProxy: boolean | string;
}

export interface PrivacyCheck {
  hasSensitiveHeaders: boolean;
  hasPrivateTargetUrl: boolean;
}

export interface NeedsCloudResult {
  required: boolean;
  reason: string;
}

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      normalized_email?: string;
      name: string;
      password_hash: string;
      is_admin: boolean;
      platform_role?: string;
      email_verified_at?: string | null;
      auth_version?: number;
      account_id?: string;
      status: string;
      suspended_until: string | null;
      created_at: string;
      updated_at: string;
    }
  }
}

export interface User {
  id: string;
  email: string;
  normalized_email?: string;
  name: string;
  password_hash: string;
  is_admin: boolean;
  platform_role?: string;
  email_verified_at?: string | null;
  auth_version?: number;
  account_id?: string;
  status: string;
  suspended_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  account_id?: string;
  name: string;
  key_hash: string;
  key_value: string | null;
  key_prefix: string;
  revoked: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}
