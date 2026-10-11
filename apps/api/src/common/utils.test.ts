import { describe, expect, it } from "vitest";
import {
  collectTargetUrls,
  findObjectsByKey,
  hasPrivateTargetUrl,
  inspectBody,
  walk,
} from "./utils";

describe("hasPrivateTargetUrl", () => {
  it.each([
    "http://localhost/",
    "http://LOCALHOST:3000/path",
    "http://app.localhost/",
    "http://printer.local/",
    "http://db.internal/",
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://0.0.0.0/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:192.168.1.1]/",
    "http://[::ffff:c0a8:101]/",
    "http://[::ffff:127.0.0.1]/",
  ])("treats %s as private", (url) => {
    expect(hasPrivateTargetUrl([url])).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://sub.example.com:8443/x",
    "http://8.8.8.8/",
    "http://172.15.255.255/",
    "http://172.32.0.1/",
    "http://192.169.0.1/",
    "http://169.253.0.1/",
    "http://[2001:db8::1]/",
    "http://[::ffff:8.8.8.8]/",
    "http://[fec0::1]/",
  ])("treats %s as public", (url) => {
    expect(hasPrivateTargetUrl([url])).toBe(false);
  });

  it("is true when any URL is private and ignores unparseable entries", () => {
    expect(hasPrivateTargetUrl(["https://example.com/", "http://10.1.1.1/"])).toBe(true);
    expect(hasPrivateTargetUrl(["not a url", "https://example.com/"])).toBe(false);
    expect(hasPrivateTargetUrl([])).toBe(false);
  });
});

describe("collectTargetUrls", () => {
  it("collects unique http(s) strings from nested bodies, case-insensitively", () => {
    const body = {
      url: "https://a.example/",
      nested: { urls: ["HTTP://b.example/", "https://a.example/", "ftp://c.example/"] },
      text: "see https://not-at-start.example/",
      number: 7,
    };

    expect(collectTargetUrls(body)).toEqual(["https://a.example/", "HTTP://b.example/"]);
  });

  it("returns nothing for bodies without URLs", () => {
    expect(collectTargetUrls(null)).toEqual([]);
    expect(collectTargetUrls({ a: [1, true, "plain"] })).toEqual([]);
  });
});

describe("inspectBody", () => {
  const json = { "content-type": "application/json; charset=utf-8" };

  it("skips bodies that are empty or not JSON", () => {
    expect(inspectBody(undefined, json)).toEqual({ json: null, parseError: null });
    expect(inspectBody(null, json)).toEqual({ json: null, parseError: null });
    expect(inspectBody(Buffer.from("a=b"), { "content-type": "text/plain" })).toEqual({
      json: null,
      parseError: null,
    });
  });

  it("parses buffered JSON and passes already-parsed bodies through", () => {
    expect(inspectBody(Buffer.from('{"a":1}'), json)).toEqual({ json: { a: 1 }, parseError: null });
    const parsed = { a: 1 };
    expect(inspectBody(parsed, json).json).toBe(parsed);
  });

  it("reports malformed JSON without throwing", () => {
    const result = inspectBody(Buffer.from('{"a":'), json);

    expect(result.json).toBeNull();
    expect(result.parseError).toEqual(expect.any(String));
  });
});

describe("walk and findObjectsByKey", () => {
  it("visits every nested value", () => {
    const seen: unknown[] = [];
    walk({ a: [1, { b: 2 }] }, (value) => seen.push(value));

    expect(seen).toEqual([{ a: [1, { b: 2 }] }, [1, { b: 2 }], 1, { b: 2 }, 2]);
  });

  it("finds values of a key in objects at any depth but not in arrays", () => {
    const body = { headers: { x: 1 }, items: [{ headers: { y: 2 } }], other: { headers: "h" } };

    expect(findObjectsByKey(body, "headers")).toEqual([{ x: 1 }, { y: 2 }, "h"]);
    expect(findObjectsByKey([{ headers: 1 }], "headers")).toEqual([1]);
  });
});
