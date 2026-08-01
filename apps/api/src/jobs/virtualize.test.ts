import { expect, it } from "vitest";
import { virtualizeCreationResponse } from "./virtualize";

it("replaces upstream async identifiers without leaking them", () => {
  const result = virtualizeCreationResponse(Buffer.from('{"success":true,"id":"upstream-id","url":"https://upstream/job"}'), "public-id", "/e/endpoint/v2/crawl/public-id");
  expect(result?.upstreamJobId).toBe("upstream-id");
  expect(result?.body.toString()).toBe('{"success":true,"id":"public-id","url":"/e/endpoint/v2/crawl/public-id"}');
});

it("replaces the documented nested scrape session ID", () => {
  const result = virtualizeCreationResponse(
    Buffer.from('{"success":true,"data":{"markdown":"content","metadata":{"scrapeId":"upstream-scrape-id"}}}'),
    "public-id",
    "/job",
  );
  expect(result?.upstreamJobId).toBe("upstream-scrape-id");
  expect(result?.body.toString()).toBe('{"success":true,"data":{"markdown":"content","metadata":{"scrapeId":"public-id"}}}');
});

it("refuses a response without an async ID", () => {
  expect(virtualizeCreationResponse(Buffer.from('{"success":true}'), "public-id", "/job")).toBeNull();
});
