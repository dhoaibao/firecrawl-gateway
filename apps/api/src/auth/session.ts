import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import crypto from "node:crypto";
import { getPool } from "../db";
import { rootLogger } from "../logger";

export function parseCookieSecure(value: string | undefined): boolean | "auto" {
  if (value === undefined || value.trim() === "") return "auto";
  const s = value.toLowerCase().trim();
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "auto") return "auto";
  return "auto";
}

export function createSessionMiddleware(sessionSecret: string) {
  const secret = sessionSecret || crypto.randomBytes(32).toString("hex");
  if (!sessionSecret) {
    rootLogger.warn("SESSION_SECRET is not set. A random secret was generated. Sessions will not persist across restarts.");
  }

  const PgStore = connectPgSimple(session);

  return session({
    store: new PgStore({
      pool: getPool(),
      createTableIfMissing: true,
      tableName: "sessions",
    }),
    secret,
    resave: false,
    saveUninitialized: false,
    name: "firecrawl.sid",
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      secure: parseCookieSecure(process.env.SESSION_SECURE),
      sameSite: "lax",
    },
  });
}
