import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import crypto from "node:crypto";
import { getPool } from "../db";

export function parseCookieSecure(value: string | undefined): boolean | "auto" {
  if (value === undefined || value.trim() === "") return "auto";
  const s = value.toLowerCase().trim();
  if (["false", "0", "no", "off"].includes(s)) return false;
  if (["true", "1", "yes", "on"].includes(s)) return true;
  return "auto";
}

export function createSessionMiddleware(sessionSecret: string) {
  if (process.env.NODE_ENV === "production" && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters in production");
  }
  const secret = sessionSecret || crypto.randomBytes(32).toString("hex");
  const secure = parseCookieSecure(process.env.SESSION_SECURE);
  const production = process.env.NODE_ENV === "production";
  const PgStore = connectPgSimple(session);

  return session({
    store: new PgStore({ pool: getPool(), createTableIfMissing: true, tableName: "sessions" }),
    secret,
    resave: false,
    saveUninitialized: false,
    name: production ? "__Host-firecrawl.sid" : "firecrawl.sid",
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: production ? true : secure,
      sameSite: "lax",
      path: "/",
    },
  });
}
