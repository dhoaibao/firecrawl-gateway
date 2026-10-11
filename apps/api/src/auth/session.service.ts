import { Inject, Injectable } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import type { AdminIdentity } from "../common/types";

export const SESSION_COOKIE = "firecrawl.sid";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_CLOCK_SKEW_MS = 60_000;

@Injectable()
export class SessionService {
  private readonly secret: string;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.secret = config.sessionSecret || crypto.randomBytes(32).toString("hex");
  }

  /**
   * The cookie is `<issuedAtMs>.<signature>`. The signature covers the admin
   * email, the issue time, and the configured password, so a session expires
   * after its max age and is invalidated when the password is rotated.
   */
  getAdmin(request: FastifyRequest): AdminIdentity | null {
    const email = this.config.adminEmail.trim().toLowerCase();
    const value = request.cookies?.[SESSION_COOKIE] ?? "";
    const separator = value.indexOf(".");
    if (!email || !this.config.adminPassword || separator < 1) return null;
    const issuedAtText = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (!/^\d{1,15}$/.test(issuedAtText)) return null;
    const issuedAt = Number(issuedAtText);
    const now = Date.now();
    if (issuedAt > now + SESSION_CLOCK_SKEW_MS || now - issuedAt > SESSION_MAX_AGE_SECONDS * 1000)
      return null;
    const expected = this.sign(email, issuedAt);
    if (
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    return { email };
  }

  setAdmin(reply: FastifyReply): void {
    const email = this.config.adminEmail.trim().toLowerCase();
    const issuedAt = Date.now();
    reply.setCookie(SESSION_COOKIE, `${issuedAt}.${this.sign(email, issuedAt)}`, {
      httpOnly: true,
      // The admin and API share a site, and "none" would let any website drive
      // the admin API (including the credit-spending playground) with this cookie.
      sameSite: "lax",
      secure: this.cookieSecure(),
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: "/",
    });
  }

  clearAdmin(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  private sign(email: string, issuedAt: number): string {
    return crypto
      .createHmac("sha256", this.secret)
      .update(`${email}\n${issuedAt}\n${this.config.adminPassword}`)
      .digest("base64url");
  }

  private cookieSecure(): boolean {
    return this.config.sessionSecure ?? process.env.NODE_ENV === "production";
  }
}
