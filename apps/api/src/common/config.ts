import { z } from "zod";

const boolFromEnv = z.preprocess((value) => {
  if (value === undefined) return true;
  const normalized = String(value).trim().toLowerCase();
  if (["", "false", "0", "no", "off"].includes(normalized)) return false;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  return value;
}, z.boolean());

const optionalOrigin = z.preprocess((value) => {
  if (!value || String(value).trim() === "") return "";
  return String(value).trim().replace(/\/$/, "");
}, z.string());

const optionalRedisUrl = z.preprocess(
  (value) => {
    if (!value || String(value).trim() === "") return "";
    return String(value).trim();
  },
  z.union([z.literal(""), z.string().url()]),
);

export const configSchema = z
  .object({
    port: z.coerce.number().int().positive().default(8080),
    cloudBaseUrl: z
      .string()
      .url()
      .default("https://api.firecrawl.dev")
      .transform((value) => value.replace(/\/+$/, "")),
    // Firecrawl from deploy/firecrawl/docker-compose.yml (published on 127.0.0.1:3002 by default).
    selfHostedBaseUrl: z
      .string()
      .url()
      .default("http://127.0.0.1:3002")
      .transform((value) => value.replace(/\/+$/, "")),
    requestTimeoutMs: z.coerce.number().int().positive().default(120_000),
    maxBodyBytes: z.coerce.number().int().positive().default(5_242_880),
    authEnabled: boolFromEnv.default(true),
    databaseUrl: z.string().min(1, "DATABASE_URL is required"),
    sessionSecret: z.string().default(""),
    firecrawlKeysEncryptionKey: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex string"),
    adminEmail: z.string().default(""),
    adminPassword: z.string().default(""),
    adminOrigin: optionalOrigin,
    apiOrigin: optionalOrigin,
    trustProxy: z.union([z.boolean(), z.string()]).default(false),
    logLevel: z.string().default("info"),
    cronSecret: z.string().default(""),
    redisUrl: optionalRedisUrl,
  })
  .superRefine((value, context) => {
    if (!value.authEnabled) return;
    if (!value.adminEmail.trim())
      context.addIssue({
        code: "custom",
        path: ["adminEmail"],
        message: "ADMIN_EMAIL is required when AUTH_ENABLED=true",
      });
    if (!value.adminPassword)
      context.addIssue({
        code: "custom",
        path: ["adminPassword"],
        message: "ADMIN_PASSWORD is required when AUTH_ENABLED=true",
      });
    if (!value.sessionSecret.trim())
      context.addIssue({
        code: "custom",
        path: ["sessionSecret"],
        message: "SESSION_SECRET is required when AUTH_ENABLED=true",
      });
  });

export type ApiConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return configSchema.parse({
    port: env.PORT,
    cloudBaseUrl: env.FIRECRAWL_CLOUD_BASE_URL,
    selfHostedBaseUrl: env.FIRECRAWL_SELF_HOSTED_URL,
    requestTimeoutMs: env.API_REQUEST_TIMEOUT_MS ?? env.GATEWAY_REQUEST_TIMEOUT_MS,
    maxBodyBytes: env.API_MAX_BODY_BYTES ?? env.GATEWAY_MAX_BODY_BYTES,
    authEnabled: env.AUTH_ENABLED,
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    firecrawlKeysEncryptionKey: env.FIRECRAWL_KEYS_ENCRYPTION_KEY,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    adminOrigin: env.ADMIN_ORIGIN,
    apiOrigin: env.API_ORIGIN,
    trustProxy: env.TRUST_PROXY,
    logLevel: env.LOG_LEVEL,
    cronSecret: env.CRON_SECRET,
    redisUrl: env.REDIS_URL,
  });
}
