import bcrypt from "bcrypt";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

// Deliberately small local deny-list; deployments may replace/extend this with a
// privacy-preserving breach service without changing the authentication contract.
const COMMON_PASSWORDS = new Set([
  "password", "password123", "123456789012", "qwertyuiop", "letmein123", "welcome123",
]);

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") return "Password is required";
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "Choose a less common password";
  return null;
}

export function bcryptRounds(): number {
  const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) throw new Error("BCRYPT_ROUNDS must be an integer between 4 and 31");
  return rounds;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, bcryptRounds());
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function needsRehash(hash: string): boolean {
  try {
    return bcrypt.getRounds(hash) < bcryptRounds();
  } catch {
    return false;
  }
}
