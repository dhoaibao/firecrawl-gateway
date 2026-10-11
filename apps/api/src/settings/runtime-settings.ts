import type { SettingRecord } from "./settings.service";

/** Settings the alert service reads on every check; all editable from the admin Configure page. */
export const ALERT_SETTING_KEYS = [
  "alert_credits_low_threshold",
  "alert_fallback_ratio_percent",
  "telegram_chat_id",
  "telegram_bot_token",
] as const;

/** Used while `alert_fallback_ratio_percent` has never been saved. */
export const DEFAULT_ALERT_FALLBACK_RATIO_PERCENT = 50;
export const MAX_RESPONSE_CACHE_TTL_SECONDS = 86_400;
export const MAX_ALERT_CREDITS_THRESHOLD = 1_000_000_000;

/** `<bot id>:<secret>` as issued by @BotFather. */
export const TELEGRAM_BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
/** A numeric chat id (negative for groups and channels) or a public `@channelname`. */
export const TELEGRAM_CHAT_ID_PATTERN = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/**
 * The stored non-negative integer, or `fallback` when the setting is missing or
 * unreadable. Settings are strings in the database and may be hand-edited.
 */
export function integerSetting(record: SettingRecord | null | undefined, fallback: number): number {
  if (!record || record.value.trim() === "") return fallback;
  const value = Number(record.value);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** `123456789:AAH...` shown as `123456789:••••`: enough to recognise the bot, not to use it. */
export function maskBotToken(token: string): string {
  const botId = token.split(":", 1)[0];
  return `${botId}:••••••••`;
}
