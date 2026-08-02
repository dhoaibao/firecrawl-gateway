import type { RouteMode } from "./settings/service";

export interface AuditEntry {
  id: string;
  created_at: string;
  method: string;
  path: string;
  route_mode: string;
  backend_used: string;
  funding_type?: "byok" | "included" | "unknown";
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
  /** Provenance of the concrete infrastructure source selected for this attempt. */
  sourceId?: string;
  credentialId?: string;
  fundingType?: "byok" | "included";
  durationMs: number;
  /** True when an upstream fetch was actually attempted (chargeable dispatch). */
  dispatched?: boolean;
  /** True when the request was rejected before any upstream fetch. */
  preDispatchFailure?: boolean;
  /** Overrides the 502 default for gateway-originated rejections (e.g. quota). */
  statusCode?: number;
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
  publicAppUrl?: string;
  authEncryptionKey?: string;
  /** Legacy settings encryption key retained during the source conversion window. */
  firecrawlKeysEncryptionKey: string;
  /** Provider credential vault key; defaults to the legacy key only for compatibility. */
  providerCredentialsEncryptionKey?: string;
  brevoApiKey?: string;
  brevoSenderEmail?: string;
  brevoSenderName?: string;
  brevoWebhookToken?: string;
  registrationEnabled?: boolean;
  adminEmail: string;
  adminPassword: string;
  trustProxy: boolean | string;
  /** Maximum operator-configured lifetime for user-created gateway tokens. */
  gatewayTokenMaxLifetimeDays?: number;
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
      mfa_enabled?: boolean;
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
  mfa_enabled?: boolean;
  account_id?: string;
  status: string;
  suspended_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface GatewayToken {
  id: string;
  user_id: string;
  account_id?: string;
  name: string;
  key_hash: string;
  /** Legacy ciphertext may exist during migration; it is never returned or read by new code. */
  key_value: string | null;
  key_prefix: string;
  scopes?: string[];
  expires_at?: string | null;
  inactivity_timeout_seconds?: number | null;
  status?: "active" | "expired" | "inactive" | "revoked";
  revoked: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** @deprecated Use GatewayToken. Retained while the admin API path remains /api-keys. */
export type ApiKey = GatewayToken;
