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
  firecrawlKeysEncryptionKey: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex string"),
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
    firecrawlKeysEncryptionKey: env.FIRECRAWL_KEYS_ENCRYPTION_KEY,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    trustProxy: env.TRUST_PROXY,
  });

  if (!parsed.sessionSecret && env.NODE_ENV === "production") {
    console.warn("Warning: SESSION_SECRET is empty in production. Sessions may be insecure.");
  }

  return parsed;
}
