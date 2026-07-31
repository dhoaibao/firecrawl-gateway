import type { User } from "../types";

function serializeTimestamp(value: string | Date): string;
function serializeTimestamp(value: string | Date | null): string | null;
function serializeTimestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeUser(user: User): Omit<User, "password_hash"> {
  const { password_hash: _passwordHash, ...safeUser } = user;
  return {
    ...safeUser,
    suspended_until: serializeTimestamp(safeUser.suspended_until),
    created_at: serializeTimestamp(safeUser.created_at),
    updated_at: serializeTimestamp(safeUser.updated_at),
  };
}
