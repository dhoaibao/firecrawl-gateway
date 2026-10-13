import { Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import crypto from "node:crypto";
import type { FastifyReply } from "fastify";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import type { RequestWithContext } from "../common/types";
import {
  AccountDisabledError,
  AccountExistsError,
  IdentityInUseError,
  UsersService,
} from "../users/users.service";
import {
  OAuthError,
  authorizeUrl,
  completeOAuth,
  createPkce,
  enabledProviders,
  isOAuthProvider,
  type OAuthProviderName,
} from "./oauth-providers";
import { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_MS, OAuthStateCodec } from "./oauth-state";
import { USER_SESSION_COOKIE, UserGuard, isTrustedOrigin } from "./user.guard";

/** Error codes the portal's sign-in page understands; nothing provider-specific is passed along. */
type LoginError =
  | "invalid_state"
  | "access_denied"
  | "provider_error"
  | "email_unverified"
  | "account_disabled"
  | "account_exists"
  | "identity_in_use"
  | "login_required"
  | "server_error";

const STATE_COOKIE_PATH = "/portal/api/auth";

@Controller("portal/api/auth")
export class PortalAuthController {
  private readonly codec: OAuthStateCodec;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly users: UsersService,
  ) {
    this.codec = new OAuthStateCodec(config.sessionSecret);
  }

  /** Which sign-in buttons the portal should show. */
  @Get("providers")
  providers() {
    return { data: { providers: enabledProviders(this.config) } };
  }

  /**
   * Starts sign-in. With `?link=1` a signed-in user instead links another provider
   * to their own account; that is the only way a second provider joins an account.
   */
  @Get("login/:provider")
  async login(
    @Param("provider") provider: string,
    @Query("link") link: unknown,
    @Req() request: RequestWithContext,
    @Res() reply: FastifyReply,
  ) {
    const name = this.enabledProvider(provider);
    if (!name) return reply.code(404).send({ success: false, error: "Unknown sign-in provider" });
    let linkUserId: string | undefined;
    if (link === "1") {
      const current = await this.currentUser(request);
      if (!current) return this.fail(reply, "login_required");
      linkUserId = current.id;
    }
    const state = crypto.randomBytes(24).toString("base64url");
    const { verifier, challenge } = createPkce();
    reply.setCookie(
      OAUTH_STATE_COOKIE,
      this.codec.encode({
        state,
        verifier,
        provider: name,
        expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
        ...(linkUserId ? { linkUserId } : {}),
      }),
      {
        httpOnly: true,
        // Lax so the cookie comes back on the provider's top-level redirect to the callback.
        sameSite: "lax",
        secure: this.cookieSecure(),
        maxAge: OAUTH_STATE_TTL_MS / 1000,
        path: STATE_COOKIE_PATH,
      },
    );
    return reply.redirect(authorizeUrl(this.config, name, { state, challenge }), 302);
  }

  @Get("callback/:provider")
  async callback(
    @Param("provider") provider: string,
    @Query() query: { code?: unknown; state?: unknown; error?: unknown },
    @Req() request: RequestWithContext,
    @Res() reply: FastifyReply,
  ) {
    const name = this.enabledProvider(provider);
    if (!name) return reply.code(404).send({ success: false, error: "Unknown sign-in provider" });
    // The sign-in attempt is single-use whatever happens next.
    const stored = this.codec.decode(request.cookies?.[OAUTH_STATE_COOKIE]);
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: STATE_COOKIE_PATH });

    if (typeof query.error === "string" && query.error) return this.fail(reply, "access_denied");
    const state = typeof query.state === "string" ? query.state : "";
    const code = typeof query.code === "string" ? query.code : "";
    if (
      !stored ||
      stored.provider !== name ||
      !state ||
      !code ||
      !OAuthStateCodec.stateMatches(stored.state, state)
    )
      return this.fail(reply, "invalid_state");

    try {
      if (stored.linkUserId) {
        // The browser that finishes linking must still be signed in as the user who started it.
        const current = await this.currentUser(request);
        if (!current || current.id !== stored.linkUserId) return this.fail(reply, "invalid_state");
        const linked = await completeOAuth(this.config, name, code, stored.verifier);
        await this.users.linkIdentity(current.id, linked);
        return reply.redirect(`${this.config.portalOrigin}/?linked=${name}`, 302);
      }
      const profile = await completeOAuth(this.config, name, code, stored.verifier);
      const user = await this.users.resolveOAuthUser(profile);
      const session = await this.users.createSession(
        user.id,
        String(request.headers["user-agent"] ?? "") || undefined,
      );
      reply.setCookie(USER_SESSION_COOKIE, session.token, {
        httpOnly: true,
        // The portal and the API share a site; "none" would let any website use this session.
        sameSite: "lax",
        secure: this.cookieSecure(),
        expires: session.expiresAt,
        path: "/",
      });
      return reply.redirect(`${this.config.portalOrigin}/`, 302);
    } catch (error) {
      if (error instanceof OAuthError) return this.fail(reply, error.code);
      if (error instanceof AccountDisabledError) return this.fail(reply, "account_disabled");
      if (error instanceof AccountExistsError) return this.fail(reply, "account_exists");
      if (error instanceof IdentityInUseError) return this.fail(reply, "identity_in_use");
      return this.fail(reply, "server_error");
    }
  }

  @Get("me")
  @UseGuards(UserGuard)
  me(@Req() request: RequestWithContext) {
    return { data: request.user };
  }

  @Post("logout")
  async logout(@Req() request: RequestWithContext, @Res() reply: FastifyReply) {
    if (!isTrustedOrigin(this.config, request))
      return reply.code(403).send({ success: false, error: "Forbidden origin" });
    const token = request.cookies?.[USER_SESSION_COOKIE];
    if (token) await this.users.revokeSession(token);
    reply.clearCookie(USER_SESSION_COOKIE, { path: "/" });
    return reply.send({ success: true });
  }

  private async currentUser(request: RequestWithContext) {
    const token = request.cookies?.[USER_SESSION_COOKIE];
    return token ? this.users.validateSession(token) : null;
  }

  private enabledProvider(provider: string): OAuthProviderName | null {
    return isOAuthProvider(provider) && enabledProviders(this.config).includes(provider)
      ? provider
      : null;
  }

  private fail(reply: FastifyReply, error: LoginError) {
    return reply.redirect(
      `${this.config.portalOrigin}/login?error=${encodeURIComponent(error)}`,
      302,
    );
  }

  private cookieSecure(): boolean {
    return this.config.sessionSecure ?? process.env.NODE_ENV === "production";
  }
}
