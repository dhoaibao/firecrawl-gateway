import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertService } from "./alert.service";

const TOKEN = "123456789:AAH_test-token_0123456789abcdef";
const CHAT_ID = "-1001234567890";

type Circuit = "closed" | "half-open" | "open";

function makeAlerts(configOverrides: Record<string, unknown> = {}) {
  const state = {
    credits: { keys: 2, credits: 10_000 },
    fallback: { total: 0, fallbacks: 0 },
    circuit: "closed" as Circuit,
  };
  const metrics = {
    recentFallbackStats: vi.fn(() => state.fallback),
    circuitStateNow: vi.fn(() => state.circuit),
    recordAlert: vi.fn(),
  };
  const credits = { estimatedRemainingCredits: vi.fn(() => state.credits) };
  const service = new AlertService(
    {
      telegramBotToken: TOKEN,
      telegramChatId: CHAT_ID,
      alertCreditsLowThreshold: 500,
      alertFallbackRatioPercent: 50,
      ...configOverrides,
    } as never,
    metrics as never,
    credits as never,
  );
  return { service, state, metrics, credits };
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
  it("is off, sends nothing, and starts no timer without a bot token and chat id", async () => {
    vi.useFakeTimers();
    const { service, state } = makeAlerts({ telegramBotToken: "", telegramChatId: "" });
    state.circuit = "open";

    service.onModuleInit();
    await service.evaluate();
    vi.advanceTimersByTime(10 * MINUTE);

    expect(service.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
    const disabled = makeAlerts({ alertCreditsLowThreshold: 0 });
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
    const { service, state } = makeAlerts({ alertFallbackRatioPercent: 0 });
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
