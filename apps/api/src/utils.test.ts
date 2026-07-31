import { describe, it, expect, vi } from "vitest";
import {
  hasPrivateTargetUrl,
  inspectBody,
  collectTargetUrls,
  escapeHtml,
  writeJson,
  walk,
  findObjectsByKey,
  cryptoRandomId,
  shuffleArray,
} from "./utils";

describe("hasPrivateTargetUrl", () => {
  it("detects localhost", () => {
    expect(hasPrivateTargetUrl(["http://localhost/"])).toBe(true);
    expect(hasPrivateTargetUrl(["http://localhost:3002/api"])).toBe(true);
  });

  it("detects IPv4 loopback", () => {
    expect(hasPrivateTargetUrl(["http://127.0.0.1/"])).toBe(true);
    expect(hasPrivateTargetUrl(["http://127.0.0.1:8080/v1/scrape"])).toBe(true);
  });

  it("detects IPv6 loopback", () => {
    expect(hasPrivateTargetUrl(["http://[::1]/"])).toBe(true);
  });

  it("detects IPv4-mapped IPv6 loopback", () => {
    expect(hasPrivateTargetUrl(["http://[::ffff:127.0.0.1]/"])).toBe(true);
  });

  it("detects private IPv4 ranges", () => {
    expect(hasPrivateTargetUrl(["http://10.0.0.1/"])).toBe(true);
    expect(hasPrivateTargetUrl(["http://172.16.0.1/"])).toBe(true);
    expect(hasPrivateTargetUrl(["http://192.168.1.1/"])).toBe(true);
    expect(hasPrivateTargetUrl(["http://169.254.1.1/"])).toBe(true);
  });

  it("detects IPv4-mapped private addresses", () => {
    expect(hasPrivateTargetUrl(["http://[::ffff:192.168.1.1]/"])).toBe(true);
    expect(hasPrivateTargetUrl(["http://[::ffff:10.0.0.1]/"])).toBe(true);
  });

  it("returns false for public URLs", () => {
    expect(hasPrivateTargetUrl(["https://api.firecrawl.dev/v1/scrape"])).toBe(false);
    expect(hasPrivateTargetUrl(["https://example.com"])).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(hasPrivateTargetUrl(["not-a-url"])).toBe(false);
  });
});

describe("inspectBody", () => {
  it("parses JSON when content-type is application/json", () => {
    const body = Buffer.from(JSON.stringify({ url: "https://example.com" }));
    const result = inspectBody(body, { "content-type": "application/json" });
    expect(result.json).toEqual({ url: "https://example.com" });
    expect(result.parseError).toBeNull();
  });

  it("returns null for empty body", () => {
    const result = inspectBody(Buffer.alloc(0), { "content-type": "application/json" });
    expect(result.json).toBeNull();
    expect(result.parseError).toBeNull();
  });

  it("returns null for non-JSON content", () => {
    const body = Buffer.from("text");
    const result = inspectBody(body, { "content-type": "text/plain" });
    expect(result.json).toBeNull();
    expect(result.parseError).toBeNull();
  });

  it("returns parse error for malformed JSON", () => {
    const body = Buffer.from("{not json");
    const result = inspectBody(body, { "content-type": "application/json" });
    expect(result.json).toBeNull();
    expect(result.parseError).toContain("JSON");
  });
});

describe("collectTargetUrls", () => {
  it("collects unique http/https URLs", () => {
    const body = {
      url: "https://example.com",
      urls: ["http://example.com/path", "https://example.com"],
      ignored: "ftp://files.example.com",
    };
    expect(collectTargetUrls(body)).toEqual([
      "https://example.com",
      "http://example.com/path",
    ]);
  });
});

describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;",
    );
  });
});

describe("writeJson", () => {
  it("writes JSON response with headers", () => {
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as {
      writeHead: (status: number, headers: Record<string, string>) => void;
      end: (body: Buffer) => void;
    };
    writeJson(res, 200, { ok: true }, { "x-custom": "value" });
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        "content-type": "application/json; charset=utf-8",
        "content-length": expect.any(String),
        "x-custom": "value",
      }),
    );
    expect(res.end).toHaveBeenCalledWith(Buffer.from(JSON.stringify({ ok: true })));
  });
});

describe("walk", () => {
  it("visits nested values", () => {
    const visited: unknown[] = [];
    walk({ a: [1, { b: 2 }] }, (v) => visited.push(v));
    expect(visited.length).toBe(5);
  });
});

describe("findObjectsByKey", () => {
  it("finds values by key across nested objects", () => {
    const result = findObjectsByKey({ headers: { a: 1 }, body: { headers: { b: 2 } } }, "headers");
    expect(result).toHaveLength(2);
  });
});

describe("cryptoRandomId", () => {
  it("returns a UUID v4 string", () => {
    const id = cryptoRandomId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe("shuffleArray", () => {
  it("returns a new array with the same elements", () => {
    const original = ["a", "b", "c", "d", "e"];
    const shuffled = shuffleArray(original);
    expect(shuffled).not.toBe(original);
    expect(shuffled).toHaveLength(original.length);
    expect(shuffled.sort()).toEqual(original.sort());
  });

  it("handles empty arrays", () => {
    expect(shuffleArray([])).toEqual([]);
  });

  it("handles single-element arrays", () => {
    expect(shuffleArray(["only"])).toEqual(["only"]);
  });
});
