import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import type { PortalUserIdentity } from "../common/types";
import type { OAuthProfile } from "../portal-auth/oauth-providers";

export const USER_SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
/** `last_seen_at` is written at most this often per session. */
const LAST_SEEN_INTERVAL_MS = 60_000;

export class AccountDisabledError extends Error {
  constructor() {
    super("account_disabled");
    this.name = "AccountDisabledError";
  }
}

/** A user with this verified email already exists; the new provider must be linked while signed in. */
export class AccountExistsError extends Error {
  constructor() {
    super("account_exists");
    this.name = "AccountExistsError";
  }
}

/** The provider account is already attached to a different user. */
export class IdentityInUseError extends Error {
  constructor() {
    super("identity_in_use");
    this.name = "IdentityInUseError";
  }
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function toIdentity(user: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: string;
}): PortalUserIdentity {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
  };
}

/** Accounts and server-side sessions of portal users. */
@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds or creates the account for a provider-verified identity.
   *
   * 1. The same provider account always resolves to the same user.
   * 2. A provider account that is new to us but whose email belongs to an existing
   *    user is NOT linked automatically: the email on record can be stale (the
   *    mailbox may since have changed hands), so it is not proof of ownership.
   *    The owner links it while signed in, through `linkIdentity`.
   * 3. Otherwise a new user is created.
   *
   * Throws `AccountDisabledError` for a suspended or deleted user and
   * `AccountExistsError` for case 2.
   */
  async resolveOAuthUser(profile: OAuthProfile): Promise<PortalUserIdentity> {
    try {
      return await this.resolveOnce(profile);
    } catch (error) {
      // Two sign-ins of the same new account raced; the loser re-reads the winner's rows.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        return this.resolveOnce(profile);
      throw error;
    }
  }

  private async resolveOnce(profile: OAuthProfile): Promise<PortalUserIdentity> {
    const identity = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerUserId: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
        },
      },
      include: { user: true },
    });
    const now = new Date();
    if (identity) {
      this.assertActive(identity.user);
      await this.prisma.user.update({
        where: { id: identity.user.id },
        data: {
          lastLoginAt: now,
          ...(identity.user.name ? {} : { name: profile.name }),
          ...(identity.user.avatarUrl ? {} : { avatarUrl: profile.avatarUrl }),
        },
      });
      return toIdentity(identity.user);
    }

    const existing = await this.prisma.user.findUnique({ where: { email: profile.email } });
    if (existing) throw new AccountExistsError();

    const created = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        lastLoginAt: now,
        identities: {
          create: {
            id: crypto.randomUUID(),
            provider: profile.provider,
            providerUserId: profile.providerUserId,
            email: profile.email,
            emailVerified: true,
          },
        },
      },
    });
    return toIdentity(created);
  }

  /**
   * Attaches a provider account to a user who is signed in and just proved they
   * control it. Idempotent for the same user; refuses a provider account that
   * already belongs to someone else.
   */
  async linkIdentity(userId: string, profile: OAuthProfile): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AccountDisabledError();
    this.assertActive(user);
    const existing = await this.prisma.userIdentity.findUnique({
      where: {
        provider_providerUserId: {
          provider: profile.provider,
          providerUserId: profile.providerUserId,
        },
      },
    });
    if (existing) {
      if (existing.userId === userId) return;
      throw new IdentityInUseError();
    }
    try {
      await this.prisma.userIdentity.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          provider: profile.provider,
          providerUserId: profile.providerUserId,
          email: profile.email,
          emailVerified: true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw new IdentityInUseError();
      throw error;
    }
  }

  private assertActive(user: { status: string; deletedAt: Date | null }): void {
    if (user.status !== "active" || user.deletedAt !== null) throw new AccountDisabledError();
  }

  /** Starts a session; only a hash of the returned token is stored. */
  async createSession(userId: string, userAgent: string | undefined) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + USER_SESSION_TTL_MS);
    await this.prisma.userSession.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        tokenHash: hashToken(token),
        userAgent: userAgent ? userAgent.slice(0, 255) : null,
        expiresAt,
      },
    });
    return { token, expiresAt };
  }

  /** The user behind a session token, or null when it is unknown, expired, revoked or disabled. */
  async validateSession(token: string): Promise<PortalUserIdentity | null> {
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    const now = Date.now();
    if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= now) return null;
    if (session.user.status !== "active" || session.user.deletedAt !== null) return null;
    if (!session.lastSeenAt || now - session.lastSeenAt.getTime() > LAST_SEEN_INTERVAL_MS) {
      void this.prisma.userSession
        .update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } })
        .catch(() => undefined);
    }
    return toIdentity(session.user);
  }

  async revokeSession(token: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Signs a user out everywhere, e.g. when an admin suspends the account. */
  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
