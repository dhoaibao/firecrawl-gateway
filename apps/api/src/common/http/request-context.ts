import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { User } from "../../types";

/** Request-scoped metadata shared by native Nest controllers and guards. */
export interface RequestMetadata {
  requestId?: string;
  clientIp: string;
  userAgent?: string;
}

/** Account context is populated by an account guard once account selection is native. */
export interface AccountContext {
  accountId: string;
}

export type RequestWithContext = FastifyRequest & {
  requestId?: string;
  authUser?: User;
  accountContext?: AccountContext;
};

function requestFrom(context: ExecutionContext): RequestWithContext {
  return context.switchToHttp().getRequest<RequestWithContext>();
}

export function requestMetadata(request: {
  id?: string;
  ip: string;
  headers: Record<string, string | string[] | undefined>;
  requestId?: string;
}): RequestMetadata {
  const userAgent = request.headers["user-agent"];
  return {
    requestId: request.requestId ?? request.id,
    clientIp: request.ip,
    userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
  };
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => requestFrom(context).authUser,
);

export const CurrentAccount = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => requestFrom(context).accountContext,
);

export const RequestId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => requestFrom(context).requestId,
);

export const ClientIp = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => requestFrom(context).ip,
);

export const UserAgent = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const userAgent = requestFrom(context).headers["user-agent"];
    return Array.isArray(userAgent) ? userAgent[0] : userAgent;
  },
);
