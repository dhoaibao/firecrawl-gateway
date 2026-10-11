import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { decryptSettingValue } from "../common/crypto";
import { CreditRoutingService } from "../credits/credit-routing.service";
import { MetricsService } from "../metrics/metrics.service";
import {
  ALERT_SETTING_KEYS,
  DEFAULT_ALERT_FALLBACK_RATIO_PERCENT,
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_CHAT_ID_PATTERN,
  integerSetting,
} from "../settings/runtime-settings";
import { SettingsService } from "../settings/settings.service";

const CHECK_INTERVAL_MS = 60_000;
const FALLBACK_WINDOW_MINUTES = 10;
/** Below this many backend-reaching requests a fallback ratio is just noise. */
const FALLBACK_MIN_REQUESTS = 20;
/** While a rule keeps firing it is repeated at most this often. */
const REMINDER_MS = 60 * 60_000;
/** A rule resolves only after this many consecutive clean checks, so a flapping signal stays quiet. */
const RESOLVE_AFTER_CLEAN_CHECKS = 3;
const SEND_TIMEOUT_MS = 10_000;
const MESSAGE_PREFIX = "[firecrawl-gateway]";

type RuleName = "credits_low" | "fallback_rate" | "circuit_open";

interface RuleState {
  firing: boolean;
  lastNotifiedAt: number;
  cleanChecks: number;
}

/** What one evaluation reads from the Configure settings. */
interface AlertSettings {
  botToken: string;
  chatId: string;
  creditsThreshold: number;
  ratioThreshold: number;
}

interface RuleCheck {
  rule: RuleName;
  active: boolean;
  firingText: string;
  resolvedText: string;
}

/**
 * Sends Telegram notifications when the gateway needs attention: low estimated
 * Cloud credits, a high fallback ratio, or an open self-hosted circuit. Its
 * settings come from the admin Configure page and are re-read on every check, so
 * changes apply within a minute without a restart; it stays idle until a bot
 * token and chat id are saved. Messages carry only aggregate numbers: never API
 * keys, key ids, target URLs, or client data.
 */
@Injectable()
export class AlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertService.name);
  private readonly states = new Map<RuleName, RuleState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  /** Identifies the saved token + chat the incident state belongs to. */
  private destination = "";

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly metrics: MetricsService,
    private readonly credits: CreditRoutingService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.evaluate(), CHECK_INTERVAL_MS);
    // Alerting must never keep the process alive on shutdown.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs every rule once. Safe to call concurrently: overlapping runs are skipped. */
  async evaluate(now = Date.now()): Promise<void> {
    if (this.evaluating) return;
    this.evaluating = true;
    try {
      const settings = await this.loadSettings();
      if (!settings) {
        // Not configured (or just removed): forget incident state so a later
        // re-configuration starts clean instead of staying "already alerted".
        this.states.clear();
        this.destination = "";
        return;
      }
      // A different bot or chat is a different audience: it must get its own initial
      // alert, and must not receive the "resolved" of an incident it never heard of.
      const destination = `${settings.chatId}\n${settings.botToken}`;
      if (destination !== this.destination) {
        this.states.clear();
        this.destination = destination;
      }
      const checks = this.collectChecks(settings, now);
      // A rule that was switched off forgets its incident, so switching it back on
      // announces a current problem instead of treating it as already notified.
      for (const rule of [...this.states.keys()]) {
        if (!checks.some((check) => check.rule === rule)) this.states.delete(rule);
      }
      for (const check of checks) await this.apply(check, settings, now);
    } catch (error) {
      this.logger.warn(`Alert evaluation failed: ${(error as Error).message}`);
    } finally {
      this.evaluating = false;
    }
  }

  /** The saved settings, or null while alerting is not (validly) configured. */
  private async loadSettings(): Promise<AlertSettings | null> {
    const stored = await this.settings.getSettings(ALERT_SETTING_KEYS);
    const chatId = stored.telegram_chat_id?.value.trim() ?? "";
    const encryptedToken = stored.telegram_bot_token?.value ?? "";
    if (!chatId || !encryptedToken || !TELEGRAM_CHAT_ID_PATTERN.test(chatId)) return null;
    let botToken: string;
    try {
      botToken = decryptSettingValue(encryptedToken, this.config.firecrawlKeysEncryptionKey).value;
    } catch (error) {
      // Only the error class is logged: it must never carry stored secret material.
      this.logger.warn(
        `Could not read the stored Telegram bot token (${(error as Error).name}); ` +
          "check FIRECRAWL_KEYS_ENCRYPTION_KEY and save the token again",
      );
      return null;
    }
    if (!TELEGRAM_BOT_TOKEN_PATTERN.test(botToken)) return null;
    return {
      botToken,
      chatId,
      creditsThreshold: integerSetting(stored.alert_credits_low_threshold, 0),
      ratioThreshold: integerSetting(
        stored.alert_fallback_ratio_percent,
        DEFAULT_ALERT_FALLBACK_RATIO_PERCENT,
      ),
    };
  }

  private collectChecks(settings: AlertSettings, now: number): RuleCheck[] {
    const checks: RuleCheck[] = [];

    const creditsThreshold = settings.creditsThreshold;
    if (creditsThreshold > 0) {
      const { keys, credits } = this.credits.estimatedRemainingCredits();
      checks.push({
        rule: "credits_low",
        active: keys > 0 && credits < creditsThreshold,
        firingText: `Estimated Firecrawl Cloud credits are low: about ${credits} left across ${keys} key(s) (alert threshold ${creditsThreshold}).`,
        resolvedText: `Estimated Firecrawl Cloud credits recovered: about ${credits} left across ${keys} key(s).`,
      });
    }

    const ratioThreshold = settings.ratioThreshold;
    if (ratioThreshold > 0) {
      const { total, fallbacks } = this.metrics.recentFallbackStats(FALLBACK_WINDOW_MINUTES, now);
      const percent = total > 0 ? Math.round((fallbacks / total) * 100) : 0;
      checks.push({
        rule: "fallback_rate",
        active: total >= FALLBACK_MIN_REQUESTS && percent >= ratioThreshold,
        firingText: `${percent}% of requests used a fallback in the last ${FALLBACK_WINDOW_MINUTES} minutes (${fallbacks} of ${total}, alert threshold ${ratioThreshold}%).`,
        resolvedText: `The fallback rate is back to ${percent}% (${fallbacks} of ${total} requests in the last ${FALLBACK_WINDOW_MINUTES} minutes).`,
      });
    }

    const circuit = this.metrics.circuitStateNow();
    checks.push({
      rule: "circuit_open",
      active: circuit !== "closed",
      firingText: `The self-hosted backend circuit breaker is ${circuit}: requests fail fast or use a fallback instead of reaching self-hosted.`,
      resolvedText: "The self-hosted backend circuit breaker is closed again.",
    });

    return checks;
  }

  private async apply(check: RuleCheck, settings: AlertSettings, now: number): Promise<void> {
    const state = this.states.get(check.rule) ?? {
      firing: false,
      lastNotifiedAt: 0,
      cleanChecks: 0,
    };
    this.states.set(check.rule, state);

    if (check.active) {
      state.cleanChecks = 0;
      if (!state.firing) {
        // Only a delivered alert counts as firing, so a failed send is retried next check.
        if (await this.send(settings, check.rule, `${MESSAGE_PREFIX} ALERT: ${check.firingText}`)) {
          state.firing = true;
          state.lastNotifiedAt = now;
        }
      } else if (now - state.lastNotifiedAt >= REMINDER_MS) {
        if (
          await this.send(
            settings,
            check.rule,
            `${MESSAGE_PREFIX} STILL FIRING: ${check.firingText}`,
          )
        )
          state.lastNotifiedAt = now;
      }
      return;
    }

    if (!state.firing) return;
    state.cleanChecks += 1;
    if (state.cleanChecks < RESOLVE_AFTER_CLEAN_CHECKS) return;
    if (
      await this.send(settings, check.rule, `${MESSAGE_PREFIX} RESOLVED: ${check.resolvedText}`)
    ) {
      state.firing = false;
      state.cleanChecks = 0;
    }
  }

  /** Delivers one message; failures are logged (never with the token) and reported as false. */
  private async send(settings: AlertSettings, rule: RuleName, text: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.telegram.org/bot${settings.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: settings.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Telegram rejected the ${rule} alert with HTTP ${response.status}`);
        this.metrics.recordAlert(rule, "failed");
        return false;
      }
      this.metrics.recordAlert(rule, "sent");
      return true;
    } catch (error) {
      // Only the error class is logged: its message can embed the request URL, which holds the token.
      this.logger.warn(`Could not send the ${rule} alert: ${(error as Error).name}`);
      this.metrics.recordAlert(rule, "failed");
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}
