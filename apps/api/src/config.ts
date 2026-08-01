import { z } from "zod";
import type { GatewayConfig } from "./types";

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const GatewayConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(8080),
  cloudBaseUrl: z.string().min(1).default("https://api.firecrawl.dev").transform(stripTrailingSlash),
  defaultRouteMode: z.literal("cloud-first").default("cloud-first"),
  requestTimeoutMs: z.coerce.number().int().positive().default(120_000),
  logFile: z.string().min(1).default("/data/hybrid-firecrawl-requests.jsonl"),
  maxBodyBytes: z.coerce.number().int().positive().default(5_242_880),
  authEnabled: z.preprocess(
    (val) => {
      if (val === undefined) return true;
      const s = String(val).toLowerCase().trim();
      if (["", "false", "0", "no", "off"].includes(s)) return false;
      if (["true", "1", "yes", "on"].includes(s)) return true;
      return val;
    },
    z.boolean(),
  ),
  databaseUrl: z.string().min(1, "DATABASE_URL is required"),
  operatorDatabaseUrl: z.string().min(1, "OPERATOR_DATABASE_URL is required"),
  sessionSecret: z.string().default(""),
  publicAppUrl: z.preprocess(
    (value) => value || undefined,
    z.string().url().optional(),
  ).transform((value) => value ? stripTrailingSlash(value) : ""),
  authEncryptionKey: z.string().default(""),
  firecrawlKeysEncryptionKey: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex string"),
  providerCredentialsEncryptionKey: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex string"),
  brevoApiKey: z.string().default(""),
  brevoSenderEmail: z.string().email().default("noreply@example.com"),
  brevoSenderName: z.string().min(1).default("Firecrawl Gateway"),
  brevoWebhookToken: z.string().default(""),
  registrationEnabled: z.preprocess(
    (val) => val === undefined ? false : ["true", "1", "yes", "on"].includes(String(val).toLowerCase()),
    z.boolean(),
  ),
  adminEmail: z.string().default(""),
  adminPassword: z.string().default(""),
  trustProxy: z.preprocess(
    (val) => {
      if (val === undefined) return false;
      const s = String(val).toLowerCase().trim();
      if (["", "false", "0", "no", "off"].includes(s)) return false;
      if (["true", "1", "yes", "on"].includes(s)) return true;
      return val;
    },
    z.boolean().or(z.string()).default(false),
  ),
});

/** Parse an injected environment without terminating the importing process. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = GatewayConfigSchema.parse({
    port: env.PORT,
    cloudBaseUrl: "https://api.firecrawl.dev",
    defaultRouteMode: "cloud-first",
    requestTimeoutMs: env.GATEWAY_REQUEST_TIMEOUT_MS,
    logFile: env.GATEWAY_LOG_FILE,
    maxBodyBytes: env.GATEWAY_MAX_BODY_BYTES,
    authEnabled: env.AUTH_ENABLED,
    databaseUrl: env.DATABASE_URL,
    operatorDatabaseUrl: env.OPERATOR_DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    publicAppUrl: env.PUBLIC_APP_URL,
    authEncryptionKey: env.AUTH_ENCRYPTION_KEY,
    firecrawlKeysEncryptionKey: env.FIRECRAWL_KEYS_ENCRYPTION_KEY,
    // Compatibility fallback is intentionally one-way: new deployments should
    // configure an independent vault key before converting legacy settings.
    providerCredentialsEncryptionKey: env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY || env.FIRECRAWL_KEYS_ENCRYPTION_KEY,
    brevoApiKey: env.BREVO_API_KEY,
    brevoSenderEmail: env.BREVO_SENDER_EMAIL,
    brevoSenderName: env.BREVO_SENDER_NAME,
    brevoWebhookToken: env.BREVO_WEBHOOK_TOKEN,
    registrationEnabled: env.REGISTRATION_ENABLED,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    trustProxy: env.TRUST_PROXY,
  });

  if (env.NODE_ENV === "production" && parsed.authEnabled) {
    if (parsed.sessionSecret.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters in production");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(parsed.authEncryptionKey)) {
      throw new Error("AUTH_ENCRYPTION_KEY must be a 64-character hex string in production");
    }
    if (!parsed.publicAppUrl) {
      throw new Error("PUBLIC_APP_URL is required when authentication is enabled in production");
    }
  }

  return parsed;
}
