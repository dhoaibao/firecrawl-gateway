import { describe, expect, it } from "vitest";
import { chooseInitialBackend, getRouteMode, hasPrivateTargetUrl, requestNeedsCloud, tokenScopeAllowsPath, validateGatewayRequest } from "./gateway-policy";

describe("native gateway policy", () => {
  it("resolves valid route mode precedence", () => {
    expect(getRouteMode("/v1/scrape?routeMode=cloud-only", { "x-firecrawl-route-mode": "self-hosted-only" }, "cloud-first")).toBe("self-hosted-only");
    expect(getRouteMode("/v1/scrape?routeMode=cloud-only", {}, "self-hosted-first")).toBe("cloud-only");
    expect(getRouteMode("/v1/scrape?routeMode=invalid", {}, "invalid")).toBe("cloud-first");
  });

  it("forces Cloud for managed features and rejects incompatible self-hosted-only requests", () => {
    const needsCloud = requestNeedsCloud("/v1/agent/run", {});
    expect(needsCloud.required).toBe(true);
    expect(chooseInitialBackend("self-hosted-only", needsCloud)).toBe("reject");
  });

  it("enforces versioned scopes and bounded request inputs", () => {
    expect(tokenScopeAllowsPath(["v1:scrape"], "/v1/scrape")).toBe(true);
    expect(tokenScopeAllowsPath(["v1:scrape"], "/v1/crawl")).toBe(false);
    expect(validateGatewayRequest("/v1/crawl", { maxPages: 10_001 })?.statusCode).toBe(413);
    expect(validateGatewayRequest("/v1/scrape", { url: "file:///etc/passwd" })?.statusCode).toBe(400);
    expect(hasPrivateTargetUrl({ url: "http://127.0.0.1/private" })).toBe(true);
  });
});
