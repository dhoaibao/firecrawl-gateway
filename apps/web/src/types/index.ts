import type { RouteMode } from "@/lib/routing"

/** Audit log entry from the gateway */
export interface AuditEntry {
  id: string
  created_at: string
  method: string
  path: string
  route_mode: string
  backend_used: string
  fallback_used: boolean
  fallback_reason: string
  status_code: number
  duration_ms: number
  target_url: string
  user_id?: string
}

/** User record from the admin API */
export interface UserData {
  id: string
  email: string
  name: string
  is_admin: boolean
  status: "active" | "suspended" | "blocked"
  suspended_until: string | null
  created_at: string
  updated_at: string
}

/** API key record */
export interface ApiKeyData {
  id: string
  user_id: string
  name: string
  key_prefix: string
  revoked: boolean
  created_at: string
  updated_at: string
  last_used_at: string | null
  key?: string // available for re-copying when retained by the gateway
}

/** Backend filter option */
export type BackendFilter = "" | "self-hosted" | "cloud"

/** HTTP status category filter */
export type StatusFilter = "" | "2xx" | "4xx" | "5xx"

/** Date range preset */
export type DateRange = "all" | "today" | "week" | "month" | "custom"

/** Suspend duration unit */
export type SuspendUnit = "hours" | "days" | "weeks"

/** Generic API response wrapper */
export interface ApiResponse<T> {
  data: T
}

/** Settings record from admin API */
export interface SettingsData {
  firecrawl_api_keys?: string[]
  user_inactivity_suspend_days?: number
  api_key_inactivity_revoke_days?: number
  default_route_mode?: RouteMode
  self_hosted_firecrawl_url?: string
}

/** Credit usage item for a single API key */
export interface CreditUsageItem {
  keyIndex: number
  keyPrefix: string
  remainingCredits: number | null
  planCredits: number | null
  billingPeriodStart: string | null
  billingPeriodEnd: string | null
  error?: string
}

/** Generic API error response */
export interface ApiError {
  error: string
}
