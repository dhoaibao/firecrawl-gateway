import session from "express-session";
import type { Prisma, PrismaClient } from "@prisma/client";

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type StoredSession = session.SessionData;

function serializeSession(value: StoredSession): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function expiresAt(value: StoredSession): Date {
  if (value.cookie?.expires) {
    const expires = new Date(value.cookie.expires);
    if (!Number.isNaN(expires.getTime())) return expires;
  }
  const maxAge = value.cookie?.maxAge;
  return new Date(Date.now() + (typeof maxAge === "number" ? maxAge : DEFAULT_SESSION_TTL_MS));
}

export class PrismaSessionStore extends session.Store {
  constructor(private readonly client: PrismaClient) {
    super();
  }

  get(sid: string, callback: (err: unknown, session?: StoredSession | null) => void): void {
    void this.client.session.findUnique({ where: { sid } })
      .then(async (record) => {
        if (!record || record.expire <= new Date()) {
          if (record) await this.client.session.deleteMany({ where: { sid } });
          callback(null, null);
          return;
        }
        callback(null, record.sess as unknown as StoredSession);
      })
      .catch((error: unknown) => callback(error));
  }

  set(sid: string, value: StoredSession, callback?: (err?: unknown) => void): void {
    void this.client.session.upsert({
      where: { sid },
      create: { sid, sess: serializeSession(value), expire: expiresAt(value) },
      update: { sess: serializeSession(value), expire: expiresAt(value) },
    })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    void this.client.session.deleteMany({ where: { sid } })
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  clear(callback?: (err?: unknown) => void): void {
    void this.client.session.deleteMany()
      .then(() => callback?.())
      .catch((error: unknown) => callback?.(error));
  }

  length(callback: (err: unknown, length?: number) => void): void {
    void this.client.session.count()
      .then((count) => callback(null, count))
      .catch((error: unknown) => callback(error));
  }

  all(callback: (err: unknown, sessions?: { [sid: string]: StoredSession } | null) => void): void {
    void this.client.session.findMany()
      .then((records) => {
        const sessions: { [sid: string]: StoredSession } = {};
        for (const record of records) sessions[record.sid] = record.sess as unknown as StoredSession;
        callback(null, sessions);
      })
      .catch((error: unknown) => callback(error));
  }

  touch(sid: string, value: StoredSession, callback?: () => void): void {
    void this.client.session.updateMany({
      where: { sid },
      data: { expire: expiresAt(value) },
    })
      .then(() => callback?.())
      .catch(() => callback?.());
  }
}
