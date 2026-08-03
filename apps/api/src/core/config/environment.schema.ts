import { z } from "zod";

const booleanValue = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean());

const DEVELOPMENT_SESSION_SECRET = "development-only-session-secret-change-me";
const DEVELOPMENT_ENCRYPTION_KEY = "0".repeat(64);
const DEVELOPMENT_PUBLIC_APP_URL = "http://localhost:3000";

export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65_535).default(8080),
  DATABASE_URL: z.string({ required_error: "DATABASE_URL is required" }).min(1, "DATABASE_URL is required"),
  TRUST_PROXY: z.union([booleanValue, z.string().min(1)]).default(false),
  AUTH_ENABLED: booleanValue.default(true),
  REGISTRATION_ENABLED: booleanValue.default(true),
  ADMIN_EMAIL: z.union([z.string().email(), z.literal("")]).default(""),
  SESSION_SECRET: z.string().min(32).default(DEVELOPMENT_SESSION_SECRET),
  SESSION_SECURE: z.union([booleanValue, z.literal("auto")]).default("auto"),
  AUTH_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "AUTH_ENCRYPTION_KEY must be 32-byte hex").default(DEVELOPMENT_ENCRYPTION_KEY),
  PROVIDER_CREDENTIALS_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "PROVIDER_CREDENTIALS_ENCRYPTION_KEY must be 32-byte hex").default(DEVELOPMENT_ENCRYPTION_KEY),
  CLOUD_BASE_URL: z.string().url().default("https://api.firecrawl.dev"),
  BREVO_WEBHOOK_TOKEN: z.string().default(""),
  WORKER_HEARTBEAT_FILE: z.string().min(1).default("/tmp/firecrawl-worker-heartbeat"),
  PUBLIC_APP_URL: z.string().url().default(DEVELOPMENT_PUBLIC_APP_URL),
  CORS_ORIGIN: z.string().default(""),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(31).default(12),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV !== "production" || !environment.AUTH_ENABLED) return;
  if (environment.SESSION_SECRET === DEVELOPMENT_SESSION_SECRET) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["SESSION_SECRET"], message: "SESSION_SECRET must be configured in production" });
  }
  if (environment.AUTH_ENCRYPTION_KEY === DEVELOPMENT_ENCRYPTION_KEY) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["AUTH_ENCRYPTION_KEY"], message: "AUTH_ENCRYPTION_KEY must be configured in production" });
  }
  if (environment.PUBLIC_APP_URL === DEVELOPMENT_PUBLIC_APP_URL) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["PUBLIC_APP_URL"], message: "PUBLIC_APP_URL must be configured in production" });
  }
});

export type Environment = z.infer<typeof environmentSchema>;

export function validateEnvironment(environment: Record<string, unknown>): Environment {
  return environmentSchema.parse(environment);
}
