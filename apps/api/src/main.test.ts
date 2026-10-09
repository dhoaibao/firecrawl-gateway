import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Capture the options the REAL createApp() passes to fastify-raw-body while
// passing through to the genuine implementation, so this test guards the
// actual registration (main.ts) instead of a hand-built Fastify instance.
const capturedRawBodyOptions: Array<Record<string, unknown> | undefined> = [];

vi.mock("fastify-raw-body", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify-raw-body")>();
  const realPlugin = actual.default as unknown as ((...pluginArgs: unknown[]) => unknown) &
    Record<PropertyKey, unknown>;
  const plugin = (...args: unknown[]) => {
    capturedRawBodyOptions.push(args[1] as Record<string, unknown> | undefined);
    return realPlugin(...args);
  };
  // fastify-plugin attaches skip-override/plugin-meta symbols to the exported
  // function; copying them keeps Fastify from creating a child encapsulation
  // context, so decorations and hooks land on the root instance as in prod.
  return { default: Object.assign(plugin, realPlugin) };
});

// Must run before "./main" is imported (static imports are hoisted), so the
// test environment is complete before the module evaluates. main.ts only
// starts listening when run directly, so importing it here does not bind a port.
const savedEnv = vi.hoisted(() => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://user:password@localhost:5432/firecrawl_gateway_test",
    // Prisma connects lazily on first query, so a non-listening URL is safe here.
    FIRECRAWL_KEYS_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    AUTH_ENABLED: "false",
    LOG_LEVEL: "silent",
  });
  return saved;
});

import { createApp } from "./main";

let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  app = await createApp();
});

afterAll(async () => {
  await app?.close();
  process.env = savedEnv;
});

describe("raw request body handling", () => {
  it("registers fastify-raw-body via createApp with UTF-8 decoding", () => {
    expect(capturedRawBodyOptions).toEqual([
      { field: "rawBody", global: true, encoding: "utf8", runFirst: true },
    ]);
  });

  it("keeps the malformed JSON 400 through the real app pipeline", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/test",
      headers: { "content-type": "application/json" },
      payload: '{"x":',
    });

    expect(response.statusCode).toBe(400);
    // The real createApp pipeline serializes the parse failure through the
    // Nest/Fastify exception handling, which differs from a bare Fastify
    // instance: statusCode + message only, no code/error fields.
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 400,
      message: "Body is not valid JSON but content-type is set to 'application/json'",
    });
  });
});
