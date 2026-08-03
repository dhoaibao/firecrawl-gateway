import pino from "pino";

export const rootLogger = pino({
  level: process.env.LOG_LEVEL || "info",
});

export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return rootLogger.child(bindings);
}
