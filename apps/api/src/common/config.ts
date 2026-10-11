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

const MIN_METRICS_TOKEN_LENGTH = 16;

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
    // Consecutive self-hosted failures (network error, 502/503/504) that open the
    // circuit breaker; 0 disables it. The circuit stays open for the cooldown.
    selfHostedBreakerFailureThreshold: z.coerce.number().int().min(0).default(5),
    selfHostedBreakerCooldownMs: z.coerce.number().int().positive().default(30_000),
    maxBodyBytes: z.coerce.number().int().positive().default(5_242_880),
    authEnabled: boolFromEnv.default(true),
    databaseUrl: z.string().min(1, "DATABASE_URL is required"),
    sessionSecret: z.string().default(""),
    // Unset follows NODE_ENV: the session cookie is Secure only in production.
    sessionSecure: z.preprocess((value) => {
      const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
      if (["false", "0", "no", "off"].includes(normalized)) return false;
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      return undefined;
    }, z.boolean().optional()),
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
    // Bearer token for GET /admin/api/metrics; unset disables the endpoint (404).
    metricsToken: z.string().default(""),
    // In-memory cache of successful Cloud scrape responses; 0 (default) disables it.
    responseCacheTtlSeconds: z.coerce.number().int().min(0).max(86_400).default(0),
    responseCacheMaxBytes: z.coerce
      .number()
      .int()
      .min(1_048_576)
      .max(2_147_483_647)
      .default(67_108_864),
    // Telegram alerts are enabled only when both the bot token and chat id are set.
    telegramBotToken: z.string().trim().default(""),
    telegramChatId: z.string().trim().default(""),
    // Alert when the estimated remaining Cloud credits fall below this; 0 disables the rule.
    alertCreditsLowThreshold: z.coerce.number().int().min(0).default(0),
    // Alert when this share of recent requests used a fallback; 0 disables the rule.
    alertFallbackRatioPercent: z.coerce.number().int().min(0).max(100).default(50),
    redisUrl: optionalRedisUrl,
  })
  .superRefine((value, context) => {
    if (Boolean(value.telegramBotToken) !== Boolean(value.telegramChatId))
      context.addIssue({
        code: "custom",
        path: ["telegramBotToken"],
        message: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together",
      });
    // The token is interpolated into the Bot API URL path, so only the documented shape is accepted.
    if (value.telegramBotToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(value.telegramBotToken))
      context.addIssue({
        code: "custom",
        path: ["telegramBotToken"],
        message: "TELEGRAM_BOT_TOKEN must look like <bot id>:<secret> from @BotFather",
      });
    if (value.metricsToken && value.metricsToken.length < MIN_METRICS_TOKEN_LENGTH)
      context.addIssue({
        code: "custom",
        path: ["metricsToken"],
        message: `METRICS_TOKEN must be at least ${MIN_METRICS_TOKEN_LENGTH} characters`,
      });
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
    selfHostedBreakerFailureThreshold: env.SELF_HOSTED_BREAKER_FAILURE_THRESHOLD,
    selfHostedBreakerCooldownMs: env.SELF_HOSTED_BREAKER_COOLDOWN_MS,
    maxBodyBytes: env.API_MAX_BODY_BYTES ?? env.GATEWAY_MAX_BODY_BYTES,
    authEnabled: env.AUTH_ENABLED,
    databaseUrl: env.DATABASE_URL,
    sessionSecret: env.SESSION_SECRET,
    sessionSecure: env.SESSION_SECURE,
    firecrawlKeysEncryptionKey: env.FIRECRAWL_KEYS_ENCRYPTION_KEY,
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    adminOrigin: env.ADMIN_ORIGIN,
    apiOrigin: env.API_ORIGIN,
    trustProxy: env.TRUST_PROXY,
    logLevel: env.LOG_LEVEL,
    cronSecret: env.CRON_SECRET,
    metricsToken: env.METRICS_TOKEN,
    responseCacheTtlSeconds: env.RESPONSE_CACHE_TTL_SECONDS,
    responseCacheMaxBytes: env.RESPONSE_CACHE_MAX_BYTES,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    alertCreditsLowThreshold: env.ALERT_CREDITS_LOW_THRESHOLD,
    alertFallbackRatioPercent: env.ALERT_FALLBACK_RATIO_PERCENT,
    redisUrl: env.REDIS_URL,
  });
}
