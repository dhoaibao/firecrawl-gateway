import { describe, it, expect } from "vitest";
import {
  getRouteMode,
  requestNeedsCloud,
  chooseInitialBackend,
  isFallbackAllowed,
  isFallbackEligible,
  isCloudQuotaFallbackAllowed,
  hasSensitiveHeaders,
} from "./policy";

describe("getRouteMode", () => {
  it("uses header value when valid", () => {
    expect(
      getRouteMode("/v1/scrape", { "x-firecrawl-route-mode": "cloud-first" }, "self-hosted-first"),
    ).toBe("cloud-first");
  });

  it("uses query value when valid", () => {
    expect(getRouteMode("/v1/scrape?routeMode=self-hosted-only", {}, "self-hosted-first")).toBe("self-hosted-only");
  });

  it("falls back to default when invalid", () => {
    expect(getRouteMode("/v1/scrape", { "x-firecrawl-route-mode": "invalid" }, "self-hosted-first")).toBe(
      "self-hosted-first",
    );
  });

  it("defaults to cloud-first when default is invalid", () => {
    expect(getRouteMode("/v1/scrape", {}, "invalid" as string)).toBe("cloud-first");
  });
});

describe("requestNeedsCloud", () => {
  it("requires cloud for agent paths", () => {
    const result = requestNeedsCloud("/v1/agent/run", null);
    expect(result.required).toBe(true);
  });

  it("requires cloud for browser paths", () => {
    const result = requestNeedsCloud("/v1/browser/snapshot", null);
    expect(result.required).toBe(true);
  });

  it("requires cloud for monitor paths", () => {
    const result = requestNeedsCloud("/v1/monitor/jobs", null);
    expect(result.required).toBe(true);
  });

  it.each([
    "/v2/search/research/papers",
    "/v2/research",
    "/v2/support/ask",
    "/v2/team/activity",
    "/v2/feedback",
  ])("requires cloud for managed path %s", (path) => {
    expect(requestNeedsCloud(path, null).required).toBe(true);
  });

  it("requires cloud for scrape interact paths", () => {
    const result = requestNeedsCloud("/v1/scrape/abc/interact", null);
    expect(result.required).toBe(true);
  });

  it("requires cloud for search feedback paths", () => {
    const result = requestNeedsCloud("/v1/search/abc/feedback", null);
    expect(result.required).toBe(true);
  });

  it("requires cloud for actions in body", () => {
    const result = requestNeedsCloud("/v1/scrape", { actions: [{ type: "click" }] });
    expect(result.required).toBe(true);
  });

  it("requires cloud for agent field", () => {
    const result = requestNeedsCloud("/v1/scrape", { agent: { model: "gpt-4" } });
    expect(result.required).toBe(true);
  });

  it.each(["screenshot", "changeTracking", "branding"])(
    "allows the self-hosted backend to attempt the %s format",
    (format) => {
      expect(requestNeedsCloud("/v2/scrape", { formats: [format] }).required).toBe(false);
    },
  );

  it("requires cloud for enterprise search options", () => {
    const result = requestNeedsCloud("/v2/search", { enterprise: ["zdr"] });
    expect(result.required).toBe(true);
  });

  it("requires cloud for stealth proxy", () => {
    const result = requestNeedsCloud("/v1/scrape", { proxy: "stealth" });
    expect(result.required).toBe(true);
  });

  it("does not require cloud for basic scrape", () => {
    const result = requestNeedsCloud("/v1/scrape", { url: "https://example.com" });
    expect(result.required).toBe(false);
  });
});

describe("chooseInitialBackend", () => {
  it("chooses cloud for cloud-first", () => {
    expect(chooseInitialBackend("cloud-first", { required: false, reason: "" })).toBe("cloud");
  });

  it("chooses cloud for cloud-only", () => {
    expect(chooseInitialBackend("cloud-only", { required: false, reason: "" })).toBe("cloud");
    expect(chooseInitialBackend("cloud-only", { required: true, reason: "actions" })).toBe("cloud");
  });

  it("chooses self-hosted for self-hosted-only when no cloud requirement", () => {
    expect(chooseInitialBackend("self-hosted-only", { required: false, reason: "" })).toBe("self-hosted");
  });

  it("rejects self-hosted-only when cloud is required", () => {
    expect(chooseInitialBackend("self-hosted-only", { required: true, reason: "actions" })).toBe("reject");
  });

  it("chooses cloud for self-hosted-first when cloud is required", () => {
    expect(chooseInitialBackend("self-hosted-first", { required: true, reason: "actions" })).toBe("cloud");
  });

  it("chooses self-hosted for self-hosted-first when cloud is not required", () => {
    expect(chooseInitialBackend("self-hosted-first", { required: false, reason: "" })).toBe("self-hosted");
  });
});

describe("isFallbackAllowed", () => {
  it("allows fallback in self-hosted-first mode without privacy concerns", () => {
    expect(
      isFallbackAllowed("self-hosted-first", { hasSensitiveHeaders: false, hasPrivateTargetUrl: false }),
    ).toBe(true);
  });

  it("denies fallback outside self-hosted-first", () => {
    expect(
      isFallbackAllowed("cloud-first", { hasSensitiveHeaders: false, hasPrivateTargetUrl: false }),
    ).toBe(false);
  });

  it("denies fallback with sensitive headers", () => {
    expect(
      isFallbackAllowed("self-hosted-first", { hasSensitiveHeaders: true, hasPrivateTargetUrl: false }),
    ).toBe(false);
  });

  it("denies fallback with private target URL", () => {
    expect(
      isFallbackAllowed("self-hosted-first", { hasSensitiveHeaders: false, hasPrivateTargetUrl: true }),
    ).toBe(false);
  });
});

describe("isFallbackEligible", () => {
  it("eligible on network error", () => {
    expect(isFallbackEligible({ kind: "network-error", body: Buffer.alloc(0) })).toBe(true);
  });

  it("eligible on 5xx response", () => {
    expect(
      isFallbackEligible({
        kind: "response",
        response: new Response("", { status: 502 }),
        body: Buffer.alloc(0),
      }),
    ).toBe(true);
  });

  it("eligible on 4xx with fire-engine message", () => {
    expect(
      isFallbackEligible({
        kind: "response",
        response: new Response("", { status: 400 }),
        body: Buffer.from("fire-engine not configured"),
      }),
    ).toBe(true);
  });

  it("not eligible on 4xx without fallback keywords", () => {
    expect(
      isFallbackEligible({
        kind: "response",
        response: new Response("", { status: 404 }),
        body: Buffer.from("not found"),
      }),
    ).toBe(false);
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "is eligible when the self-hosted backend does not expose a %s route",
    (method) => {
      expect(
        isFallbackEligible({
          kind: "response",
          response: new Response("", { status: 404 }),
          body: Buffer.from(`Cannot ${method} /v2/example`),
        }),
      ).toBe(true);
    },
  );

  it("not eligible on 2xx", () => {
    expect(
      isFallbackEligible({
        kind: "response",
        response: new Response("", { status: 200 }),
        body: Buffer.from("ok"),
      }),
    ).toBe(false);
  });
});

describe("hasSensitiveHeaders", () => {
  it("detects authorization header", () => {
    expect(hasSensitiveHeaders({ Authorization: "Bearer token" }, null)).toBe(true);
  });

  it("detects cookie header case-insensitively", () => {
    expect(hasSensitiveHeaders({ cookie: "session=abc" }, null)).toBe(true);
  });

  it("detects sensitive headers in body", () => {
    expect(
      hasSensitiveHeaders({}, { headers: { "x-api-key": "secret" } }),
    ).toBe(true);
  });

  it("detects token headers in body", () => {
    expect(hasSensitiveHeaders({}, { headers: { "x-auth-token": "abc" } })).toBe(true);
  });

  it("returns false for safe headers", () => {
    expect(hasSensitiveHeaders({ "content-type": "application/json" }, null)).toBe(false);
  });
});

describe("isCloudQuotaFallbackAllowed", () => {
  it("allows fallback in cloud-first mode for requests that do not need cloud", () => {
    expect(
      isCloudQuotaFallbackAllowed("cloud-first", { required: false, reason: "" }),
    ).toBe(true);
  });

  it("denies fallback outside cloud-first", () => {
    expect(
      isCloudQuotaFallbackAllowed("self-hosted-first", { required: false, reason: "" }),
    ).toBe(false);
    expect(
      isCloudQuotaFallbackAllowed("cloud-only", { required: false, reason: "" }),
    ).toBe(false);
    expect(
      isCloudQuotaFallbackAllowed("self-hosted-only", { required: false, reason: "" }),
    ).toBe(false);
  });

  it("denies fallback when the request requires cloud features", () => {
    expect(
      isCloudQuotaFallbackAllowed("cloud-first", { required: true, reason: "actions" }),
    ).toBe(false);
  });
});
