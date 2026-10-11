import { Injectable } from "@nestjs/common";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { CreditRoutingService } from "../credits/credit-routing.service";

/**
 * Endpoint families that may appear in the `route` label. The set is fixed and
 * server-owned: the first path segment is client-controlled (and unauthenticated
 * requests are observed too), so admitting segments on first sight would let a
 * client fill the label space. Anything else is reported as `other`.
 */
const ROUTE_SEGMENTS = new Set([
  "agent",
  "batch",
  "browser",
  "crawl",
  "deep-research",
  "extract",
  "llmstxt",
  "map",
  "monitor",
  "parse",
  "research",
  "scrape",
  "search",
  "team",
]);
const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const BACKENDS = new Set(["cloud", "self-hosted"]);

export interface RequestObservation {
  /** `backend_used` as audited: `cloud`, `self-hosted`, or `none` for early rejections. */
  backend: string;
  statusCode: number;
  durationMs: number;
  fallbackUsed: boolean;
  /** Request path as the client sent it; reduced to a known `/v<n>/<endpoint>` label or `other`. */
  path: string;
}

/**
 * Prometheus metrics for the gateway. Labels are deliberately low-cardinality:
 * no API key ids, target URLs, or full paths (client-controlled) are ever labels.
 */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly requestDuration: Histogram<"backend" | "status_class" | "fallback" | "route">;
  private readonly rateLimited: Counter;

  constructor(credits: CreditRoutingService) {
    collectDefaultMetrics({ register: this.registry });

    this.requestDuration = new Histogram({
      name: "gateway_request_duration_seconds",
      help: "Gateway proxy request duration by backend used, status class, and route.",
      labelNames: ["backend", "status_class", "fallback", "route"],
      buckets: DURATION_BUCKETS_SECONDS,
      registers: [this.registry],
    });

    this.rateLimited = new Counter({
      name: "gateway_rate_limited_total",
      help: "Requests rejected by the per-IP rate limiter.",
      registers: [this.registry],
    });

    // Both gauges read process memory only (what routing last learned about the
    // Cloud keys); a scrape never calls Firecrawl Cloud.
    new Gauge({
      name: "gateway_cloud_credits_remaining_estimate",
      help: "Last-known remaining Firecrawl Cloud credits summed over tracked keys (estimate; keys removed since the last restart may still be counted).",
      registers: [this.registry],
      collect() {
        this.set(credits.estimatedRemainingCredits().credits);
      },
    });
    new Gauge({
      name: "gateway_cloud_credit_keys_tracked",
      help: "Number of Cloud API keys whose remaining credits are currently known.",
      registers: [this.registry],
      collect() {
        this.set(credits.estimatedRemainingCredits().keys);
      },
    });
  }

  /** Records one finished (or early-rejected) gateway request. Never throws. */
  observeRequest(observation: RequestObservation): void {
    try {
      this.requestDuration.observe(
        {
          backend: BACKENDS.has(observation.backend) ? observation.backend : "none",
          status_class: statusClass(observation.statusCode),
          fallback: observation.fallbackUsed ? "true" : "false",
          route: routeLabel(observation.path),
        },
        Math.max(0, observation.durationMs) / 1000,
      );
    } catch {
      // Metrics must never affect request handling.
    }
  }

  recordRateLimited(): void {
    try {
      this.rateLimited.inc();
    } catch {
      // Metrics must never affect request handling.
    }
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}

function routeLabel(path: string): string {
  const match = /^\/(v[12])\/([A-Za-z0-9_-]{1,40})/.exec(path);
  if (!match) return "other";
  const segment = match[2].toLowerCase();
  return ROUTE_SEGMENTS.has(segment) ? `/${match[1].toLowerCase()}/${segment}` : "other";
}

function statusClass(statusCode: number): string {
  const hundreds = Math.floor(statusCode / 100);
  return hundreds >= 1 && hundreds <= 5 ? `${hundreds}xx` : "other";
}
