import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { NeedsCloudResult } from "../common/types";
import type { PrivacyFlags } from "./policy";

/** A single cached body is never larger than this; bigger responses are streamed uncached. */
export const MAX_CACHED_ENTRY_BYTES = 2 * 1024 * 1024;
/** Request bodies larger than this are not inspected for caching. */
const MAX_INSPECTED_BODY_BYTES = 64 * 1024;
const SCRAPE_PATH = /^\/v[12]\/scrape\/?$/;
/**
 * Request fields that make a scrape per-user, side-effecting or cache-sensitive.
 * Firecrawl itself bypasses its own cache for `actions`, `headers`, `profile` and
 * `changeTracking`; the rest (`lockdown`, `minAge`) change cache semantics.
 */
const UNCACHEABLE_FIELDS = [
  "actions",
  "headers",
  "profile",
  "changeTracking",
  "lockdown",
  "minAge",
];
/** Fields that control caching itself and so must not be part of the cache key. */
const CONTROL_FIELDS = new Set(["maxAge", "storeInCache"]);

export interface CachedResponse {
  status: number;
  contentType: string;
  body: Buffer;
  storedAt: number;
}

export interface CacheLookup {
  key: string;
  /** Oldest acceptable entry age in ms from the request's own `maxAge`; null means the gateway TTL. */
  maxAgeMs: number | null;
}

export interface CacheEligibilityInput {
  method: string;
  /** Path and query forwarded upstream, so differing query strings never share an entry. */
  upstreamUrl: string;
  path: string;
  headers: IncomingHttpHeaders;
  apiKeyId: string | null;
  bodyBuffer: Buffer;
  initialBackend: string;
  needsCloud: NeedsCloudResult;
  privacy: PrivacyFlags;
}

/** JSON with object keys sorted, so equal requests hash equally regardless of field order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Decides whether a request may be answered from, and stored in, the response
 * cache, and derives its key. Deliberately narrow: only a plain scrape made with a
 * virtual API key, that would spend Cloud credits, with no sensitive headers,
 * private target URLs or per-user options. Returns null for everything else.
 */
export function cacheLookupFor(input: CacheEligibilityInput): CacheLookup | null {
  if (input.method !== "POST" || !SCRAPE_PATH.test(input.path)) return null;
  // The key is scoped to the virtual API key, so entries are never shared across clients.
  if (!input.apiKeyId) return null;
  // Only requests that would spend Cloud credits benefit; self-hosted is free.
  if (input.initialBackend !== "cloud" || input.needsCloud.required) return null;
  if (input.privacy.hasSensitiveHeaders || input.privacy.hasPrivateTargetUrl) return null;
  const cacheControl = String(input.headers["cache-control"] ?? "").toLowerCase();
  if (cacheControl.includes("no-cache") || cacheControl.includes("no-store")) return null;
  if (input.bodyBuffer.length === 0 || input.bodyBuffer.length > MAX_INSPECTED_BODY_BYTES)
    return null;

  let body: unknown;
  try {
    body = JSON.parse(input.bodyBuffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  if (typeof fields.url !== "string") return null;
  if (UNCACHEABLE_FIELDS.some((name) => fields[name] !== undefined)) return null;
  if (fields.zeroDataRetention === true || fields.storeInCache === false) return null;
  const maxAge = fields.maxAge;
  if (maxAge !== undefined && (typeof maxAge !== "number" || !Number.isFinite(maxAge))) return null;
  if (maxAge === 0) return null;

  const material = Object.fromEntries(
    Object.entries(fields).filter(([name]) => !CONTROL_FIELDS.has(name)),
  );
  const key = crypto
    .createHash("sha256")
    .update(`${input.apiKeyId}\n${input.upstreamUrl}\n${canonicalJson(material)}`)
    .digest("hex");
  return { key, maxAgeMs: typeof maxAge === "number" ? maxAge : null };
}

export interface ResponseCacheOptions {
  /** Entry lifetime in ms; 0 disables the cache. */
  ttlMs: number;
  /** Total size bound over all bodies; the least recently used entries are evicted first. */
  maxBytes: number;
  now?: () => number;
}

/**
 * Bounded in-memory LRU of successful scrape bodies. Per instance by design (one
 * replica is deployed); a restart empties it, which is always safe.
 */
export class ResponseCache {
  private readonly entries = new Map<string, CachedResponse>();
  private totalBytes = 0;
  private readonly now: () => number;

  constructor(private readonly options: ResponseCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.options.ttlMs > 0 && this.options.maxBytes > 0;
  }

  /** Returns a live entry no older than `maxAgeMs` (when given), refreshing its recency. */
  get(key: string, maxAgeMs: number | null): CachedResponse | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const age = this.now() - entry.storedAt;
    if (age >= this.options.ttlMs) {
      this.remove(key, entry);
      return null;
    }
    // A request-supplied `maxAge` only narrows the window; it never extends the TTL.
    if (maxAgeMs !== null && age > maxAgeMs) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: Omit<CachedResponse, "storedAt">): void {
    if (!this.enabled || entry.body.length > MAX_CACHED_ENTRY_BYTES) return;
    if (entry.body.length > this.options.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous) this.remove(key, previous);
    this.entries.set(key, { ...entry, storedAt: this.now() });
    this.totalBytes += entry.body.length;
    while (this.totalBytes > this.options.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private remove(key: string, entry: CachedResponse): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key);
      this.totalBytes -= entry.body.length;
    }
  }
}
