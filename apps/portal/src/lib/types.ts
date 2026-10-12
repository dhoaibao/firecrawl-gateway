export interface PortalUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
}

export interface Identity {
  provider: string;
  email: string;
  linked_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  rate_limit_per_minute: number | null;
}

export interface CreatedApiKey extends ApiKey {
  /** The plaintext key; the API returns it once, at creation. */
  key: string;
}

export interface CloudKey {
  id: string;
  name: string;
  key_prefix: string;
  role: "cloud" | "fallback";
  created_at: string;
  last_verified_at: string | null;
}

export interface CloudKeyStatus {
  status: "valid" | "invalid" | "unavailable";
  remaining_credits: number | null;
  plan_credits: number | null;
  billing_period_end: string | null;
}

export interface UsageKey {
  api_key_id: string;
  name: string;
  key_prefix: string;
  total: number;
  error_count: number;
  avg_duration_ms: number;
  last_request_at: string | null;
}

export interface Usage {
  range: string;
  total: number;
  error_count: number;
  avg_duration_ms: number;
  keys: UsageKey[];
}

export type ProviderName = "google" | "github";
