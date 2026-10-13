import Fastify from "fastify";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { redactLoggedUrl, serializeRequestForLog } from "./log-redaction";

describe("redactLoggedUrl", () => {
  it("drops the query of sign-in URLs and leaves everything else alone", () => {
    expect(redactLoggedUrl("/portal/api/auth/callback/google?code=abc&state=xyz")).toBe(
      "/portal/api/auth/callback/google?[redacted]",
    );
    expect(redactLoggedUrl("/portal/api/auth/providers")).toBe("/portal/api/auth/providers");
    expect(redactLoggedUrl("/v1/scrape?routeMode=cloud-only")).toBe(
      "/v1/scrape?routeMode=cloud-only",
    );
  });
});

describe("request logging", () => {
  it("never writes an OAuth code or state into the log stream", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({
      logger: { level: "info", stream, serializers: { req: serializeRequestForLog } },
    });
    app.get("/portal/api/auth/callback/google", async () => ({ ok: true }));
    await app.inject({
      method: "GET",
      url: "/portal/api/auth/callback/google?code=SECRET_CODE&state=SECRET_STATE",
    });
    await app.close();
    const output = lines.join("");
    expect(output).toContain("/portal/api/auth/callback/google?[redacted]");
    expect(output).not.toContain("SECRET_CODE");
    expect(output).not.toContain("SECRET_STATE");
  });
});
