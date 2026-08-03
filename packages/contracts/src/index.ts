import { z } from "zod";

export const routeModeSchema = z.enum([
  "self-hosted-first",
  "self-hosted-only",
  "cloud-first",
  "cloud-only",
]);

export const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  details: z.record(z.string(), z.array(z.string())).optional(),
});

export const authenticatedUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  is_admin: z.boolean(),
  status: z.enum(["active", "suspended", "blocked"]),
  suspended_until: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  email_verified_at: z.string().nullable().optional(),
  account_id: z.string().optional(),
});

export const authenticatedUserResponseSchema = z.object({
  data: authenticatedUserSchema,
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

export const healthSchema = z.object({
  status: z.enum(["ok", "ready", "not_ready"]),
  checks: z.object({ database: z.enum(["ok", "error"]) }).optional(),
});

export type RouteMode = z.infer<typeof routeModeSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
export type Health = z.infer<typeof healthSchema>;

export const operatorReasonSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export const operatorNotificationStateSchema = z.enum(["active", "acknowledged", "resolved"]);
export const operatorNotificationSchema = z.object({
  id: z.string(), type: z.string(), severity: z.enum(["info", "warning", "critical"]),
  dedup_key: z.string(), state: operatorNotificationStateSchema,
  first_occurred_at: z.string(), last_occurred_at: z.string(),
  acknowledged_at: z.string().nullable(), resolved_at: z.string().nullable(),
  payload: z.record(z.unknown()), email_status: z.string(),
});
export type OperatorNotification = z.infer<typeof operatorNotificationSchema>;

export const fundingPreferenceSchema = z.enum(["byok", "included", "auto"]);
export type FundingPreference = z.infer<typeof fundingPreferenceSchema>;

export const accountViewSchema = z.object({
  public_id: z.string(),
  display_name: z.string(),
  status: z.string(),
  funding_preference: fundingPreferenceSchema,
  created_at: z.string(),
  updated_at: z.string(),
});

export const endpointViewSchema = z.object({
  endpoint_id: z.string(),
  base_path: z.string(),
  base_url: z.string().optional(),
  immutable: z.boolean(),
  status: z.string(),
  account_status: z.string().optional(),
});

export const quotaSummarySchema = z.object({
  period_id: z.string(),
  reset_at: z.string(),
  enrollment_status: z.string(),
  entitlement_status: z.string().nullable(),
  allocated: z.number(),
  consumed: z.number(),
  reserved: z.number(),
  remaining: z.number(),
  included_traffic_available: z.boolean(),
});

export const requestSummarySchema = z.object({
  requests: z.number(),
  successful: z.number(),
  errors: z.number(),
  average_latency_ms: z.number(),
  included_requests: z.number().optional(),
  byok_requests: z.number().optional(),
});

export const portalOverviewUserSchema = authenticatedUserSchema;
export const portalOverviewSchema = z.object({
  user: portalOverviewUserSchema,
  account: accountViewSchema,
  endpoint: endpointViewSchema,
  quota: quotaSummarySchema,
  recent: requestSummarySchema,
  endpoint_base_url: z.string(),
});

export const gatewayTokenStatusSchema = z.enum(["active", "expired", "inactive", "revoked"]);
export const gatewayTokenSchema = z.object({
  id: z.string(),
  user_id: z.string().optional(),
  account_id: z.string().optional(),
  name: z.string(),
  key_prefix: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.string().nullable(),
  inactivity_timeout_seconds: z.number().nullable(),
  status: gatewayTokenStatusSchema,
  revoked: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  last_used_at: z.string().nullable(),
  key: z.string().optional(),
});

export const credentialMetadataSchema = z.object({
  id: z.string(),
  owner_type: z.enum(["account", "operator"]),
  account_id: z.string().nullable(),
  purpose: z.string(),
  key_version: z.number(),
  masked_prefix: z.string(),
  masked_suffix: z.string(),
  status: z.string(),
  provider_metadata: z.record(z.unknown()),
  last_validated_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  superseded_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const portalPaginationSchema = z.object({
  page: z.number().int().positive(),
  page_size: z.number().int().positive().max(100),
  total: z.number().int().nonnegative(),
});

export const usageItemSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  route_family: z.string(),
  funding_type: z.enum(["included", "byok", "unknown"]),
  status: z.number(),
  status_bucket: z.string(),
  duration_ms: z.number(),
  request_id: z.string().nullable(),
});

export const historyItemSchema = z.object({
  id: z.string(),
  method: z.string(),
  route_family: z.string(),
  timestamp: z.string(),
  source_class: z.string(),
  funding_type: z.enum(["included", "byok", "unknown"]),
  status: z.number(),
  duration_ms: z.number(),
  request_id: z.string().nullable(),
  target: z.literal("redacted"),
});

export const sessionViewSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  ip_label: z.string().nullable(),
  user_agent_label: z.string().nullable(),
  revoked_at: z.string().nullable(),
});

export const securityEventViewSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  created_at: z.string(),
});

export const mfaStateSchema = z.object({ enabled: z.boolean(), verified: z.boolean() });
export const mfaSetupSchema = z.object({ secret: z.string(), uri: z.string() });
export const deletionResponseSchema = z.object({ status: z.string(), workflow_id: z.string(), retention: z.string() });
export const successResponseSchema = z.object({ success: z.literal(true) });
export const accountUpdateResponseSchema = z.object({ user: authenticatedUserSchema, account: accountViewSchema });
export const accountExportSchema = z.object({
  exported_at: z.string(),
  user: authenticatedUserSchema,
  account: accountViewSchema,
  endpoint: endpointViewSchema,
  quota: quotaSummarySchema,
  tokens: z.array(gatewayTokenSchema),
  credentials: z.array(credentialMetadataSchema),
  request_history: z.array(historyItemSchema),
  request_history_truncated: z.boolean(),
  request_history_limit: z.number().int().positive(),
});
export const gatewayTokenListSchema = z.array(gatewayTokenSchema);
export const credentialMetadataListSchema = z.array(credentialMetadataSchema);
export const usagePageSchema = z.object({ items: z.array(usageItemSchema), pagination: portalPaginationSchema });
export const historyPageSchema = z.object({ items: z.array(historyItemSchema), pagination: portalPaginationSchema });
export const sessionListSchema = z.array(sessionViewSchema);
export const securityEventListSchema = z.array(securityEventViewSchema);
export const recoveryCodesResponseSchema = z.object({ recovery_codes: z.array(z.string()) });

export type AccountView = z.infer<typeof accountViewSchema>;
export type EndpointView = z.infer<typeof endpointViewSchema>;
export type QuotaSummary = z.infer<typeof quotaSummarySchema>;
export type RequestSummary = z.infer<typeof requestSummarySchema>;
export type PortalOverview = z.infer<typeof portalOverviewSchema>;
export type GatewayToken = z.infer<typeof gatewayTokenSchema>;
export type CredentialMetadata = z.infer<typeof credentialMetadataSchema>;
export type PortalPagination = z.infer<typeof portalPaginationSchema>;
export type UsageItem = z.infer<typeof usageItemSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type SessionView = z.infer<typeof sessionViewSchema>;
export type SecurityEventView = z.infer<typeof securityEventViewSchema>;

export const apiDataResponseSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema });
