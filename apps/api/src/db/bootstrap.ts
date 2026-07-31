import crypto from "node:crypto";
import { rootLogger } from "../logger";
import { withClient } from "./index";

export async function bootstrapAdminUser(
  email: string,
  name: string,
  passwordHash: string,
): Promise<void> {
  await withClient(async (client) => {
    const existing = await client.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return;
    }

    await client.query(
      `INSERT INTO users (id, email, name, password_hash, is_admin)
       VALUES ($1, $2, $3, $4, true)`,
      [crypto.randomUUID(), email, name, passwordHash],
    );

    rootLogger.info(`Admin user created: ${email}`);
  });
}
