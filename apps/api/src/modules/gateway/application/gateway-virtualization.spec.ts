import { describe, expect, it } from "vitest";
import { virtualizeCreationResponse } from "./gateway-virtualization";

describe("native gateway response virtualization", () => {
  it("replaces top-level async IDs and public URLs", () => {
    const result = virtualizeCreationResponse(Buffer.from(JSON.stringify({ id: "upstream", url: "https://upstream/jobs/upstream" })), "public", "https://gateway/jobs/public");
    expect(result?.upstreamJobId).toBe("upstream");
    expect(JSON.parse(result!.body.toString())).toEqual({ id: "public", url: "https://gateway/jobs/public" });
  });

  it("replaces nested scrape session IDs", () => {
    const result = virtualizeCreationResponse(Buffer.from(JSON.stringify({ data: { metadata: { scrapeId: "upstream" } } })), "public", "https://gateway/jobs/public");
    expect(result?.upstreamJobId).toBe("upstream");
    expect(JSON.parse(result!.body.toString()).data.metadata.scrapeId).toBe("public");
  });

  it("fails closed for non-JSON and unrelated responses", () => {
    expect(virtualizeCreationResponse(Buffer.from("not-json"), "public", "url")).toBeNull();
    expect(virtualizeCreationResponse(Buffer.from(JSON.stringify({ success: true })), "public", "url")).toBeNull();
  });
});
