import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { SessionStore } from "@fastify/session";
import { TransactionService } from "../../../core/database/transaction.service";

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
type StoredSession = Parameters<SessionStore["set"]>[1];

function serializeSession(session: StoredSession): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(session)) as Prisma.InputJsonValue;
}

function expiresAt(session: StoredSession): Date {
  const expires = session.cookie?.expires;
  if (expires) {
    const parsed = new Date(expires);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + (session.cookie?.maxAge ?? DEFAULT_SESSION_TTL_MS));
}

@Injectable()
export class PrismaSessionStore implements SessionStore {
  constructor(private readonly transactions: TransactionService) {}

  get(sessionId: string, callback: (error: unknown, session?: StoredSession | null) => void): void {
    void this.transactions.run(async (transaction) => {
      const record = await transaction.session.findUnique({ where: { sid: sessionId } });
      if (!record || record.expire <= new Date()) {
        if (record) await transaction.session.deleteMany({ where: { sid: sessionId } });
        return null;
      }
      return record.sess as unknown as StoredSession;
    })
      .then((session) => callback(null, session))
      .catch((error: unknown) => callback(error));
  }

  set(sessionId: string, session: StoredSession, callback: (error?: unknown) => void): void {
    void this.transactions.run((transaction) => transaction.session.upsert({
      where: { sid: sessionId },
      create: { sid: sessionId, sess: serializeSession(session), expire: expiresAt(session) },
      update: { sess: serializeSession(session), expire: expiresAt(session) },
    }))
      .then(() => callback())
      .catch((error: unknown) => callback(error));
  }

  destroy(sessionId: string, callback: (error?: unknown) => void): void {
    void this.transactions.run((transaction) => transaction.session.deleteMany({ where: { sid: sessionId } }))
      .then(() => callback())
      .catch((error: unknown) => callback(error));
  }
}
