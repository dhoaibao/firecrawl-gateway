import type { FastifySessionObject } from "@fastify/session";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../../../types";

export interface AuthSession extends FastifySessionObject {
  userId?: string;
  pendingMfaUserId?: string;
  pendingMfaAt?: number;
  csrfToken?: string;
  operatorStepUpAt?: number;
}

export type SessionRequest = FastifyRequest & {
  session: AuthSession;
  authUser?: User;
};

export type AuthenticatedRequest = SessionRequest & {
  authUser: User;
};

export type CookieReply = FastifyReply & {
  clearCookie(name: string, options?: { path?: string }): FastifyReply;
};
