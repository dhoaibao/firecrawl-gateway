import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSettingValue } from "../common/crypto";
import { ALERT_SETTING_KEYS } from "../settings/runtime-settings";
import { AlertService } from "./alert.service";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = "123456789:AAH_test-token_0123456789abcdef";
const CHAT_ID = "-1001234567890";

type Circuit = "closed" | "half-open" | "open";
type SettingValues = Record<(typeof ALERT_SETTING_KEYS)[number], string | null>;

function makeAlerts(overrides: Partial<SettingValues> = {}) {
  const state = {
    credits: { keys: 2, credits: 10_000 },
    fallback: { total: 0, fallbacks: 0 },
    circuit: "closed" as Circuit,
  };
  // What the admin saved on the Configure page; the bot token is stored encrypted.
  const stored: SettingValues = {
    telegram_bot_token: encryptSettingValue(TOKEN, ENCRYPTION_KEY),
    telegram_chat_id: CHAT_ID,
    alert_credits_low_threshold: "500",
    alert_fallback_ratio_percent: "50",
    ...overrides,
  };
  const settings = {
    getSettings: vi.fn(async () =>
      Object.fromEntries(
        ALERT_SETTING_KEYS.map((key) => [
          key,
          stored[key] === null ? null : { key, value: stored[key], updated_at: "" },
        ]),
      ),
    ),
  };
  const metrics = {
    recentFallbackStats: vi.fn(() => state.fallback),
    circuitStateNow: vi.fn(() => state.circuit),
    recordAlert: vi.fn(),
  };
  const credits = { estimatedRemainingCredits: vi.fn(() => state.credits) };
  const service = new AlertService(
    { firecrawlKeysEncryptionKey: ENCRYPTION_KEY } as never,
    metrics as never,
    credits as never,
    settings as never,
  );
  return { service, state, stored, settings, metrics, credits };
}

function sentTexts(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).text as string);
}

const MINUTE = 60_000;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AlertService", () => {
  it("stays silent until both a bot token and a chat id are saved", async () => {
    const { service, state, stored } = makeAlerts({
      telegram_bot_token: null,
      telegram_chat_id: null,
    });
    state.circuit = "open";

    await service.evaluate(0);
    stored.telegram_chat_id = CHAT_ID; // chat id alone is still not enough
    await service.evaluate(MINUTE);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a chat id that is not a numeric id or @channelname", async () => {
    const { service, state } = makeAlerts({ telegram_chat_id: "my chat; DROP" });
    state.circuit = "open";

    await service.evaluate(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("evaluates on a one-minute interval and stops on shutdown", async () => {
    vi.useFakeTimers();
    const { service, state } = makeAlerts();
    state.circuit = "open";

    service.onModuleInit();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("picks up changed settings on the next check without a restart", async () => {
    const { service, state, stored } = makeAlerts({ alert_credits_low_threshold: "0" });
    state.credits = { keys: 1, credits: 100 };

    await service.evaluate(0);
    expect(fetchMock).not.toHaveBeenCalled(); // credits rule disabled

    stored.alert_credits_low_threshold = "500"; // saved on the Configure page
    await service.evaluate(MINUTE);

    expect(sentTexts(fetchMock)).toEqual([expect.stringContaining("threshold 500")]);
  });

  it("uses the default fallback threshold until one is saved", async () => {
    const { service, state } = makeAlerts({ alert_fallback_ratio_percent: null });
    state.fallback = { total: 20, fallbacks: 10 };

    await service.evaluate(0);

    expect(sentTexts(fetchMock)).toEqual([expect.stringContaining("50% of requests")]);
  });

  it("forgets incident state when alerting is switched off so re-enabling starts clean", async () => {
    const { service, state, stored } = makeAlerts();
    state.circuit = "open";
    await service.evaluate(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stored.telegram_bot_token = null;
    await service.evaluate(MINUTE);
    stored.telegram_bot_token = encryptSettingValue(TOKEN, ENCRYPTION_KEY);
    await service.evaluate(2 * MINUTE);

    // The incident is announced again rather than treated as already notified.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("re-announces a rule that was switched off and on again while the problem persisted", async () => {
    const { service, state, stored } = makeAlerts();
    state.credits = { keys: 1, credits: 100 };
    await service.evaluate(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stored.alert_credits_low_threshold = "0"; // rule disabled
    await service.evaluate(MINUTE);
    stored.alert_credits_low_threshold = "500"; // and enabled again, still low
    await service.evaluate(2 * MINUTE);

    expect(sentTexts(fetchMock)).toHaveLength(2);
    expect(sentTexts(fetchMock)[1]).toContain("ALERT");
  });

  it("announces an ongoing incident to a new chat and never sends it a resolution first", async () => {
    const { service, state, stored } = makeAlerts();
    state.circuit = "open";
    await service.evaluate(0);

    stored.telegram_chat_id = "@new_alert_channel";
    await service.evaluate(MINUTE);
    state.circuit = "closed";
    await service.evaluate(2 * MINUTE);
    await service.evaluate(3 * MINUTE);
    await service.evaluate(4 * MINUTE);

    const calls = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string));
    expect(calls.map((body) => [body.chat_id, body.text.includes("ALERT")])).toEqual([
      [CHAT_ID, true],
      ["@new_alert_channel", true],
      ["@new_alert_channel", false],
    ]);
    expect(calls[2].text).toContain("RESOLVED");
  });

  it("treats a replaced bot token as a new destination too", async () => {
    const { service, state, stored } = makeAlerts();
    state.circuit = "open";
    await service.evaluate(0);

    stored.telegram_bot_token = encryptSettingValue(
      "987654321:BBH_other-token_0123456789abcdef",
      ENCRYPTION_KEY,
    );
    await service.evaluate(MINUTE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("bot987654321:");
  });

  it("posts one Telegram message with only aggregate numbers", async () => {
    const { service, state } = makeAlerts();
    state.credits = { keys: 2, credits: 120 };

    await service.evaluate(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: CHAT_ID, disable_web_page_preview: true });
    expect(body.text).toContain("ALERT");
    expect(body.text).toContain("about 120 left across 2 key(s)");
    expect(body.text).toContain("threshold 500");
    expect(Object.keys(body).sort()).toEqual(["chat_id", "disable_web_page_preview", "text"]);
  });

  it("alerts once while a condition persists, then resolves once after clean checks", async () => {
    const { service, state } = makeAlerts();
    state.credits = { keys: 1, credits: 100 };

    await service.evaluate(0);
    await service.evaluate(MINUTE);
    await service.evaluate(2 * MINUTE);
    expect(sentTexts(fetchMock)).toHaveLength(1);

    state.credits = { keys: 1, credits: 5_000 };
    await service.evaluate(3 * MINUTE);
    await service.evaluate(4 * MINUTE);
    expect(sentTexts(fetchMock)).toHaveLength(1);
    await service.evaluate(5 * MINUTE);
    await service.evaluate(6 * MINUTE);

    const texts = sentTexts(fetchMock);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("RESOLVED");
    expect(texts[1]).toContain("about 5000 left");
  });

  it("does not resolve a flapping condition that returns before three clean checks", async () => {
    const { service, state } = makeAlerts();
    state.credits = { keys: 1, credits: 100 };
    await service.evaluate(0);

    state.credits = { keys: 1, credits: 5_000 };
    await service.evaluate(MINUTE);
    await service.evaluate(2 * MINUTE);
    state.credits = { keys: 1, credits: 100 };
    await service.evaluate(3 * MINUTE);
    state.credits = { keys: 1, credits: 5_000 };
    await service.evaluate(4 * MINUTE);
    await service.evaluate(5 * MINUTE);

    expect(sentTexts(fetchMock)).toHaveLength(1);
  });

  it("repeats a still-firing alert at most once an hour", async () => {
    const { service, state } = makeAlerts();
    state.circuit = "open";

    await service.evaluate(0);
    await service.evaluate(59 * MINUTE);
    expect(sentTexts(fetchMock)).toHaveLength(1);
    await service.evaluate(60 * MINUTE);

    const texts = sentTexts(fetchMock);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("STILL FIRING");
  });

  it("ignores the credits rule when disabled or when no key's credits are known", async () => {
    const disabled = makeAlerts({ alert_credits_low_threshold: "0" });
    disabled.state.credits = { keys: 1, credits: 0 };
    await disabled.service.evaluate(0);

    const unknown = makeAlerts();
    unknown.state.credits = { keys: 0, credits: 0 };
    await unknown.service.evaluate(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs enough traffic before a fallback ratio can alert", async () => {
    const { service, state } = makeAlerts();

    state.fallback = { total: 19, fallbacks: 19 };
    await service.evaluate(0);
    expect(fetchMock).not.toHaveBeenCalled();

    state.fallback = { total: 20, fallbacks: 9 };
    await service.evaluate(MINUTE);
    expect(fetchMock).not.toHaveBeenCalled();

    state.fallback = { total: 20, fallbacks: 10 };
    await service.evaluate(2 * MINUTE);
    expect(sentTexts(fetchMock)).toEqual([expect.stringContaining("50% of requests")]);
  });

  it("disables the fallback rule at 0%", async () => {
    const { service, state } = makeAlerts({ alert_fallback_ratio_percent: "0" });
    state.fallback = { total: 100, fallbacks: 100 };

    await service.evaluate(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("alerts while the circuit is open or half-open and resolves once it stays closed", async () => {
    const { service, state } = makeAlerts();

    state.circuit = "open";
    await service.evaluate(0);
    state.circuit = "half-open";
    await service.evaluate(MINUTE);
    state.circuit = "closed";
    await service.evaluate(2 * MINUTE);
    await service.evaluate(3 * MINUTE);
    await service.evaluate(4 * MINUTE);

    const texts = sentTexts(fetchMock);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("circuit breaker is open");
    expect(texts[1]).toContain("RESOLVED");
  });

  it("treats a failed delivery as not sent and retries on the next check", async () => {
    const { service, state, metrics } = makeAlerts();
    state.circuit = "open";
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await service.evaluate(0);
    await service.evaluate(MINUTE);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(metrics.recordAlert.mock.calls).toEqual([
      ["circuit_open", "failed"],
      ["circuit_open", "sent"],
    ]);
    await service.evaluate(2 * MINUTE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never logs the bot token, even when the network error embeds the URL", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service, state } = makeAlerts();
    state.circuit = "open";
    fetchMock.mockRejectedValue(
      new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`),
    );

    await expect(service.evaluate(0)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    for (const [message] of warn.mock.calls) expect(String(message)).not.toContain(TOKEN);
  });

  it("stays off, logging only the error class, when the stored token cannot be decrypted", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const wrongKey = "f".repeat(64);
    const { service, state } = makeAlerts({
      telegram_bot_token: encryptSettingValue(TOKEN, wrongKey),
    });
    state.circuit = "open";

    await service.evaluate(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(TOKEN);
  });

  it("survives a settings read failure and tries again on the next check", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service, state, settings } = makeAlerts();
    state.circuit = "open";
    settings.getSettings.mockRejectedValueOnce(new Error("db down"));

    await expect(service.evaluate(0)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await service.evaluate(MINUTE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips an evaluation that overlaps a slow delivery", async () => {
    const { service, state } = makeAlerts();
    state.circuit = "open";
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const first = service.evaluate(0);
    // Wait until the first run is actually inside its slow delivery.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await service.evaluate(MINUTE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(new Response("{}", { status: 200 }));
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
