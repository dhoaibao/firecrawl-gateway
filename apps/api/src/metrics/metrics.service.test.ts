import { describe, expect, it, vi } from "vitest";
import { MetricsService } from "./metrics.service";

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

    service.observeRequest({
      backend: "cloud",
      statusCode: 200,
      durationMs: 120,
      fallbackUsed: true,
      path: "/v2/scrape",
    });
    service.observeRequest({
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

    service.observeRequest({
      backend: "self-hosted",
      statusCode: 200,
      durationMs: 10,
      fallbackUsed: false,
      path: "/v2/crawl/3f1c0d8e-aaaa-bbbb-cccc-123456789abc/errors",
    });
    service.observeRequest({
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
      service.observeRequest({
        backend: "none",
        statusCode: 401,
        durationMs: 1,
        fallbackUsed: false,
        path: `/v1/attacker-${i}`,
      });
    }
    service.observeRequest({
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
      service.observeRequest({
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

    service.observeRequest({
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
      service.observeRequest({
        backend: "cloud",
        statusCode: Number.NaN,
        durationMs: Number.NaN,
        fallbackUsed: false,
        path: "",
      }),
    ).not.toThrow();
  });
});
