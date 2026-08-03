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
