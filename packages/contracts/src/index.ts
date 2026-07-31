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
