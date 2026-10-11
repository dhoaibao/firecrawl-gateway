import { describe, expect, it } from "vitest";
import {
  MAX_CACHED_ENTRY_BYTES,
  ResponseCache,
  cacheLookupFor,
  type CacheEligibilityInput,
} from "./response-cache";

function input(
  body: unknown,
  overrides: Partial<CacheEligibilityInput> = {},
): CacheEligibilityInput {
  return {
    method: "POST",
    upstreamUrl: "/v1/scrape",
    path: "/v1/scrape",
    headers: {},
    apiKeyId: "key-1",
    bodyBuffer: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    initialBackend: "cloud",
    needsCloud: { required: false, reason: "" },
    privacy: { hasSensitiveHeaders: false, hasPrivateTargetUrl: false },
    ...overrides,
  } as CacheEligibilityInput;
}

const scrape = { url: "https://example.com", formats: ["markdown"] };

describe("cacheLookupFor", () => {
  it("accepts a plain scrape made with a virtual API key that would use Cloud", () => {
    const lookup = cacheLookupFor(input(scrape));

    expect(lookup).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/), maxAgeMs: null });
  });

  it("hashes equal requests equally regardless of field order and ignores cache controls", () => {
    const a = cacheLookupFor(input({ url: "https://example.com", formats: ["markdown"] }));
    const b = cacheLookupFor(
      input({
        formats: ["markdown"],
        storeInCache: true,
        maxAge: 5000,
        url: "https://example.com",
      }),
    );

    expect(b?.key).toBe(a?.key);
    expect(b?.maxAgeMs).toBe(5000);
  });

  it("separates entries by API key, endpoint, query string and any other option", () => {
    const base = cacheLookupFor(input(scrape))?.key;

    const keys = [
      cacheLookupFor(input(scrape, { apiKeyId: "key-2" }))?.key,
      cacheLookupFor(input(scrape, { upstreamUrl: "/v2/scrape", path: "/v2/scrape" }))?.key,
      cacheLookupFor(input(scrape, { upstreamUrl: "/v1/scrape?x=1" }))?.key,
      cacheLookupFor(input({ ...scrape, onlyMainContent: false }))?.key,
      cacheLookupFor(input({ ...scrape, url: "https://example.org" }))?.key,
    ];

    expect(new Set([base, ...keys]).size).toBe(6);
  });

  it.each<[string, Partial<CacheEligibilityInput>]>([
    ["a GET request", { method: "GET" }],
    ["another endpoint", { path: "/v1/crawl", upstreamUrl: "/v1/crawl" }],
    [
      "a scrape sub-resource",
      { path: "/v1/scrape/abc/interact", upstreamUrl: "/v1/scrape/abc/interact" },
    ],
    ["a request without a virtual API key", { apiKeyId: null }],
    ["a request that would use self-hosted", { initialBackend: "self-hosted" }],
    ["a Cloud-required request", { needsCloud: { required: true, reason: "x" } }],
    ["sensitive headers", { privacy: { hasSensitiveHeaders: true, hasPrivateTargetUrl: false } }],
    [
      "a private target URL",
      { privacy: { hasSensitiveHeaders: false, hasPrivateTargetUrl: true } },
    ],
    ["Cache-Control: no-cache", { headers: { "cache-control": "max-age=0, No-Cache" } }],
    ["Cache-Control: no-store", { headers: { "cache-control": "no-store" } }],
  ])("is not cacheable for %s", (_name, overrides) => {
    expect(cacheLookupFor(input(scrape, overrides))).toBeNull();
  });

  it.each([
    ["actions", { actions: [{ type: "click", selector: "#a" }] }],
    ["headers", { headers: { "x-user": "1" } }],
    ["profile", { profile: { name: "me" } }],
    ["changeTracking", { changeTracking: { mode: "git-diff" } }],
    ["lockdown", { lockdown: true }],
    ["minAge", { minAge: 1 }],
    ["zeroDataRetention", { zeroDataRetention: true }],
    ["storeInCache false", { storeInCache: false }],
    ["maxAge 0", { maxAge: 0 }],
    ["a non-numeric maxAge", { maxAge: "5" }],
  ])("is not cacheable with %s", (_name, extra) => {
    expect(cacheLookupFor(input({ ...scrape, ...extra }))).toBeNull();
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a JSON array", "[]"],
    ["a body without a url", JSON.stringify({ formats: ["markdown"] })],
    ["an empty body", ""],
  ])("is not cacheable for %s", (_name, body) => {
    expect(cacheLookupFor(input(body))).toBeNull();
  });

  it("does not inspect very large bodies", () => {
    const big = JSON.stringify({ url: "https://example.com", pad: "x".repeat(70_000) });

    expect(cacheLookupFor(input(big))).toBeNull();
  });
});

describe("ResponseCache", () => {
  function makeCache(options: { ttlMs?: number; maxBytes?: number } = {}) {
    let now = 1_000_000;
    const cache = new ResponseCache({
      ttlMs: options.ttlMs ?? 60_000,
      maxBytes: options.maxBytes ?? 1024,
      now: () => now,
    });
    return { cache, advance: (ms: number) => (now += ms) };
  }
  const entry = (size: number, tag = "a") => ({
    status: 200,
    contentType: "application/json",
    body: Buffer.alloc(size, tag),
  });

  it("is disabled with a zero TTL and stores nothing", () => {
    const { cache } = makeCache({ ttlMs: 0 });

    cache.set("k", entry(10));

    expect(cache.enabled).toBe(false);
    expect(cache.get("k", null)).toBeNull();
  });

  it("serves an entry until the TTL passes, then drops it", () => {
    const { cache, advance } = makeCache({ ttlMs: 60_000 });
    cache.set("k", entry(10));

    advance(59_999);
    expect(cache.get("k", null)?.body.length).toBe(10);
    advance(1);
    expect(cache.get("k", null)).toBeNull();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("lets a request narrow, but never extend, the acceptable age", () => {
    const { cache, advance } = makeCache({ ttlMs: 60_000 });
    cache.set("k", entry(10));
    advance(10_000);

    expect(cache.get("k", 5_000)).toBeNull();
    expect(cache.get("k", 10_000)).not.toBeNull();
    // A huge request maxAge cannot revive an entry past the gateway TTL.
    advance(50_000);
    expect(cache.get("k", 10 * 86_400_000)).toBeNull();
  });

  it("evicts the least recently used entries to stay within the byte budget", () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.set("a", entry(40, "a"));
    cache.set("b", entry(40, "b"));
    expect(cache.get("a", null)).not.toBeNull(); // a becomes most recent

    cache.set("c", entry(40, "c")); // 120 > 100: evicts b

    expect(cache.get("b", null)).toBeNull();
    expect(cache.get("a", null)).not.toBeNull();
    expect(cache.get("c", null)).not.toBeNull();
    expect(cache.bytes).toBe(80);
  });

  it("replaces an existing entry without double counting its size", () => {
    const { cache } = makeCache({ maxBytes: 100 });

    cache.set("k", entry(30));
    cache.set("k", entry(50));

    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(50);
  });

  it("refuses entries over the per-entry cap or larger than the whole budget", () => {
    const { cache } = makeCache({ maxBytes: 10 * 1024 * 1024 });
    cache.set("big", entry(MAX_CACHED_ENTRY_BYTES + 1));
    const small = makeCache({ maxBytes: 50 });
    small.cache.set("too-big-for-budget", entry(60));

    expect(cache.get("big", null)).toBeNull();
    expect(small.cache.size).toBe(0);
  });
});
