import { describe, expect, it } from "vitest";
import { classifyAsyncRoute, replaceAsyncRouteId } from "./routes";

describe("async route classification", () => {
  it.each(["/v1/crawl", "/v2/crawl", "/v1/batch/scrape", "/v2/batch/scrape", "/v1/scrape", "/v2/interact"])(
    "recognizes creation routes: %s",
    (pathname) => expect(classifyAsyncRoute("POST", pathname)).toMatchObject({ kind: "create" }),
  );

  it.each(["/v1/crawl/public-id", "/v2/batch/scrape/public-id", "/v2/scrape/public-id", "/v2/scrape/public-id/interact", "/v2/interact/public-id"])(
    "recognizes lifecycle routes: %s",
    (pathname) => expect(classifyAsyncRoute(pathname.includes("interact") && pathname.endsWith("/interact") ? "POST" : "GET", pathname)).toMatchObject({ kind: "lifecycle", publicId: "public-id" }),
  );

  it("preserves lifecycle suffixes when replacing the public ID", () => {
    const route = classifyAsyncRoute("POST", "/v2/scrape/public-id/interact");
    expect(route).not.toBeNull();
    expect(replaceAsyncRouteId(route!, "upstream/id")).toBe("/v2/scrape/upstream%2Fid/interact");
  });

  it("recognizes scrape cancellation and rejects unsupported job subroutes", () => {
    expect(classifyAsyncRoute("DELETE", "/v1/scrape/public-id")).toMatchObject({ kind: "lifecycle" });
    expect(classifyAsyncRoute("POST", "/v2/scrape/public-id/interact")).toMatchObject({ kind: "lifecycle" });
    expect(classifyAsyncRoute("GET", "/v2/scrape/public-id/interact")).toBeNull();
    expect(classifyAsyncRoute("POST", "/v2/map")).toBeNull();
    expect(classifyAsyncRoute("POST", "/v2/crawl/public-id")).toBeNull();
  });
});
