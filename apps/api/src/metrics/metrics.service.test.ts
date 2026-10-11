import { describe, expect, it, vi } from "vitest";
import { MetricsService, type RequestObservation } from "./metrics.service";

/** Observes a request; tests that do not care default to a request that reached a backend. */
function observe(
  service: MetricsService,
  observation: Omit<RequestObservation, "reachedBackend"> & { reachedBackend?: boolean },
): void {
  service.observeRequest({ reachedBackend: true, ...observation });
}

function makeService(credits = { keys: 0, credits: 0 }) {
  const routing = { estimatedRemainingCredits: vi.fn().mockReturnValue(credits) };
  return { service: new MetricsService(routing as never), routing };
}

async function scrape(service: MetricsService): Promise<string> {
  return (await service.render()).body;
}

describe("MetricsService", () => {
  it("exposes request durations by backend, status class, fallback flag, and route", async () => {
    const { service } = makeService();

    observe(service, {
      backend: "cloud",
      statusCode: 200,
      durationMs: 120,
      fallbackUsed: true,
      path: "/v2/scrape",
    });
    observe(service, {
      backend: "cloud",
      statusCode: 200,
      durationMs: 80,
      fallbackUsed: true,
      path: "/v2/scrape",
    });

    const body = await scrape(service);
    expect(body).toContain(
      'gateway_request_duration_seconds_count{backend="cloud",status_class="2xx",fallback="true",route="/v2/scrape"} 2',
    );
    expect(body).toContain(
      'gateway_request_duration_seconds_bucket{le="0.25",backend="cloud",status_class="2xx",fallback="true",route="/v2/scrape"} 2',
    );
  });

  it("reduces paths to the endpoint family and never labels with ids or query strings", async () => {
    const { service } = makeService();

    observe(service, {
      backend: "self-hosted",
      statusCode: 200,
      durationMs: 10,
      fallbackUsed: false,
      path: "/v2/crawl/3f1c0d8e-aaaa-bbbb-cccc-123456789abc/errors",
    });
    observe(service, {
      backend: "none",
      statusCode: 401,
      durationMs: 1,
      fallbackUsed: false,
      path: "/not-a-versioned-path/secret-token",
    });

    const body = await scrape(service);
    expect(body).toContain('route="/v2/crawl"');
    expect(body).toContain('route="other"');
    expect(body).not.toContain("3f1c0d8e");
    expect(body).not.toContain("secret-token");
  });

  it("keeps unknown client-chosen segments from consuming the route labels", async () => {
    const { service } = makeService();

    // Unauthenticated requests are observed too, so a client can send any path.
    for (let i = 0; i < 200; i += 1) {
      observe(service, {
        backend: "none",
        statusCode: 401,
        durationMs: 1,
        fallbackUsed: false,
        path: `/v1/attacker-${i}`,
      });
    }
    observe(service, {
      backend: "cloud",
      statusCode: 200,
      durationMs: 5,
      fallbackUsed: false,
      path: "/v1/scrape",
    });

    const body = await scrape(service);
    const routes = new Set(
      [...body.matchAll(/gateway_request_duration_seconds_count\{[^}]*route="([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );
    expect(routes).toEqual(new Set(["other", "/v1/scrape"]));
    expect(body).not.toContain("attacker-");
  });

  it("labels only v1 and v2 endpoint families", async () => {
    const { service } = makeService();

    for (const path of ["/v1/Search", "/v2/batch/scrape", "/v3/scrape", "/v1"]) {
      observe(service, {
        backend: "cloud",
        statusCode: 200,
        durationMs: 5,
        fallbackUsed: false,
        path,
      });
    }

    const body = await scrape(service);
    expect(body).toContain('route="/v1/search"');
    expect(body).toContain('route="/v2/batch"');
    expect(body).not.toContain("/v3/");
    expect(body).toContain('route="other"');
  });

  it("normalises unknown backends and out-of-range statuses", async () => {
    const { service } = makeService();

    observe(service, {
      backend: "something-else",
      statusCode: 999,
      durationMs: 5,
      fallbackUsed: false,
      path: "/v1/scrape",
    });

    expect(await scrape(service)).toContain(
      'gateway_request_duration_seconds_count{backend="none",status_class="other",fallback="false",route="/v1/scrape"} 1',
    );
  });

  it("counts rate-limited requests", async () => {
    const { service } = makeService();

    service.recordRateLimited();
    service.recordRateLimited();

    expect(await scrape(service)).toMatch(/^gateway_rate_limited_total 2$/m);
  });

  it("exposes the self-hosted circuit state, transitions, and fail-fast count", async () => {
    const { service } = makeService();
    expect(await scrape(service)).toMatch(/^gateway_self_hosted_circuit_state 0$/m);

    service.recordCircuitTransition("open");
    service.recordCircuitRejected();
    service.recordCircuitRejected();
    let body = await scrape(service);
    expect(body).toMatch(/^gateway_self_hosted_circuit_state 2$/m);
    expect(body).toContain('gateway_self_hosted_circuit_transitions_total{to="open"} 1');
    expect(body).toMatch(/^gateway_self_hosted_circuit_rejected_total 2$/m);

    service.recordCircuitTransition("half-open");
    expect(await scrape(service)).toMatch(/^gateway_self_hosted_circuit_state 1$/m);
    service.recordCircuitTransition("closed");
    body = await scrape(service);
    expect(body).toMatch(/^gateway_self_hosted_circuit_state 0$/m);
    expect(body).toContain('gateway_self_hosted_circuit_transitions_total{to="closed"} 1');
  });

  it("keeps a rolling fallback window of requests that reached a backend", () => {
    const { service } = makeService();
    const record = (backend: string, fallbackUsed: boolean, reachedBackend: boolean) =>
      observe(service, {
        backend,
        statusCode: 200,
        durationMs: 5,
        fallbackUsed,
        reachedBackend,
        path: "/v1/scrape",
      });

    record("cloud", true, true);
    record("cloud", false, true);
    record("self-hosted", false, true);
    // Not backend health: an auth/rate-limit rejection, a "no credit pool" 429 labelled
    // cloud, and an open-circuit short-circuit labelled self-hosted.
    record("none", false, false);
    record("cloud", false, false);
    record("self-hosted", false, false);

    expect(service.recentFallbackStats(10)).toEqual({ total: 3, fallbacks: 1 });
    // Outside the requested window the counts are not included.
    expect(service.recentFallbackStats(10, Date.now() + 11 * 60_000)).toEqual({
      total: 0,
      fallbacks: 0,
    });
  });

  it("tracks the circuit state and alert outcomes", async () => {
    const { service } = makeService();
    expect(service.circuitStateNow()).toBe("closed");

    service.recordCircuitTransition("open");
    service.recordAlert("circuit_open", "sent");
    service.recordAlert("circuit_open", "failed");

    expect(service.circuitStateNow()).toBe("open");
    const body = await scrape(service);
    expect(body).toContain('gateway_alerts_total{rule="circuit_open",outcome="sent"} 1');
    expect(body).toContain('gateway_alerts_total{rule="circuit_open",outcome="failed"} 1');
  });

  it("reads the credit gauges from routing memory on each scrape", async () => {
    const { service, routing } = makeService({ keys: 2, credits: 1250 });

    const body = await scrape(service);
    expect(body).toMatch(/^gateway_cloud_credits_remaining_estimate 1250$/m);
    expect(body).toMatch(/^gateway_cloud_credit_keys_tracked 2$/m);

    routing.estimatedRemainingCredits.mockReturnValue({ keys: 1, credits: 40 });
    expect(await scrape(service)).toMatch(/^gateway_cloud_credits_remaining_estimate 40$/m);
  });

  it("includes default process metrics and the Prometheus content type", async () => {
    const { service } = makeService();

    const { contentType, body } = await service.render();

    expect(contentType).toMatch(/^text\/plain/);
    expect(body).toContain("process_cpu_user_seconds_total");
  });

  it("never throws from observation, even for hostile input", () => {
    const { service } = makeService();

    expect(() =>
      observe(service, {
        backend: "cloud",
        statusCode: Number.NaN,
        durationMs: Number.NaN,
        fallbackUsed: false,
        path: "",
      }),
    ).not.toThrow();
  });
});
