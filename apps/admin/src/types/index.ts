import type { RouteMode } from "@/lib/routing";

/** Audit log entry from the gateway */
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
}

/** Per-key request counts from the retained audit log; `api_key_id` is null when unattributed. */
export interface ApiKeyUsage {
  api_key_id: string | null;
  total: number;
  error_count: number;
  fallbacks: number;
  avg_duration_ms: number;
  last_request_at: string | null;
}

/** All-time audit aggregates computed server-side over the full log */
export interface AuditStats {
  total: number;
  self_hosted: number;
  cloud: number;
  fallbacks: number;
  success_count: number;
  error_count: number;
  avg_duration_ms: number;
}

/** Global API key record */
export interface ApiKeyData {
  id: string;
  name: string;
  key_prefix: string;
  revoked: boolean;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  /** ISO time after which the key is rejected; null means it never expires. */
  expires_at: string | null;
  /** Requests per minute allowed for this key; null means no per-key limit. */
  rate_limit_per_minute: number | null;
  /** Requests allowed per calendar month (UTC); null means no quota. */
  monthly_quota: number | null;
  /** Requests counted this month as of the last counter flush; null when there is no quota. */
  quota_used?: number | null;
  /** The portal user who owns the key; null for global keys managed on the API Keys page. */
  user_id?: string | null;
  key?: string;
}

export type UserState = "active" | "suspended" | "deleted";

/** Portal-user limit overrides; null means the portal default applies. */
export interface UserLimits {
  max_api_keys: number | null;
  rate_limit_per_minute: number | null;
  monthly_quota: number | null;
}

/** A portal user as listed on the Users page. */
export interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  state: UserState;
  providers: string[];
  api_keys: number;
  cloud_keys: number;
  created_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
  limits: UserLimits;
}

export interface UserDetail extends UserSummary {
  effective_limits: UserLimits;
  active_sessions: number;
  identities: Array<{ provider: string; email: string; linked_at: string }>;
  api_key_list: Array<{
    id: string;
    name: string;
    key_prefix: string;
    revoked: boolean;
    created_at: string;
    last_used_at: string | null;
    expires_at: string | null;
    rate_limit_per_minute: number | null;
    monthly_quota: number | null;
  }>;
  cloud_key_list: Array<{
    id: string;
    name: string;
    key_prefix: string;
    role: string;
    last_verified_at: string | null;
  }>;
}

export type BackendFilter = "" | "self-hosted" | "cloud";
export type StatusFilter = "" | "2xx" | "4xx" | "5xx";
export type DateRange = "all" | "today" | "week" | "month" | "custom";

export interface ApiResponse<T> {
  data: T;
}

/** `cloud` keys serve Cloud traffic; `fallback` keys only back up self-hosted in hybrid mode. */
export type CloudKeyRole = "cloud" | "fallback";

export interface CloudKeyEntry {
  key: string;
  role: CloudKeyRole;
}

export interface SettingsData {
  firecrawl_api_keys?: CloudKeyEntry[];
  api_key_inactivity_revoke_days?: number;
  default_route_mode?: RouteMode;
  /** Seconds a successful Cloud scrape stays cached; 0 turns the response cache off. */
  response_cache_ttl_seconds?: number;
  /** Alert when estimated remaining Cloud credits fall below this; 0 disables the rule. */
  alert_credits_low_threshold?: number;
  /** Alert when this percent of recent requests used a fallback; 0 disables the rule. */
  alert_fallback_ratio_percent?: number;
  telegram_chat_id?: string;
  /** Read-only masked form (`<bot id>:••••`); the real token is write-only. */
  telegram_bot_token?: string;
}

export interface CreditUsageItem {
  keyIndex: number;
  keyPrefix: string;
  remainingCredits: number | null;
  planCredits: number | null;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  error?: string;
}

export interface ApiError {
  error: string;
}
