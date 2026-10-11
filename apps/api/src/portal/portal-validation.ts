import { apiError } from "../common/http";

const MAX_NAME_LENGTH = 100;

/** A required, trimmed display name. */
export function parseName(value: unknown): string {
  if (typeof value !== "string") apiError(400, "name is required");
  const name = value.trim();
  if (!name) apiError(400, "name is required");
  if (name.length > MAX_NAME_LENGTH)
    apiError(400, `name must be at most ${MAX_NAME_LENGTH} characters`);
  return name;
}
