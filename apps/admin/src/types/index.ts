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
  key?: string;
}

export type BackendFilter = "" | "self-hosted" | "cloud";
export type StatusFilter = "" | "2xx" | "4xx" | "5xx";
export type DateRange = "all" | "today" | "week" | "month" | "custom";

export interface ApiResponse<T> {
  data: T;
}

export interface SettingsData {
  firecrawl_api_keys?: string[];
  api_key_inactivity_revoke_days?: number;
  default_route_mode?: RouteMode;
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
