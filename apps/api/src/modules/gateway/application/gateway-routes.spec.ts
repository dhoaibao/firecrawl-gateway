import { describe, expect, it } from "vitest";
import { classifyAsyncRoute, replaceAsyncRouteId } from "./gateway-routes";

describe("native gateway async routes", () => {
  it("classifies create and lifecycle routes", () => {
    expect(classifyAsyncRoute("POST", "/v1/crawl")).toMatchObject({ kind: "create", family: "/v1/crawl" });
    expect(classifyAsyncRoute("GET", "/v2/crawl/public-id")).toMatchObject({ kind: "lifecycle", family: "/v2/crawl", publicId: "public-id" });
    expect(classifyAsyncRoute("POST", "/v1/scrape/public-id/interact")).toMatchObject({ kind: "lifecycle", suffix: "/interact" });
  });

  it("preserves lifecycle suffixes while replacing only the upstream identifier", () => {
    const route = classifyAsyncRoute("DELETE", "/v1/batch/scrape/public-id");
    expect(route && replaceAsyncRouteId(route, "upstream/id")).toBe("/v1/batch/scrape/upstream%2Fid");
  });

  it("does not claim synchronous or malformed routes", () => {
    expect(classifyAsyncRoute("GET", "/v1/crawl")).toBeNull();
    expect(classifyAsyncRoute("POST", "/v1/scrape/public-id")).toBeNull();
    expect(classifyAsyncRoute("GET", "/v3/crawl/id")).toBeNull();
  });
});
