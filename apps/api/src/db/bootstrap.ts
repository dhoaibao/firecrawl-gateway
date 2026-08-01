import crypto from "node:crypto";
import { rootLogger } from "../logger";
import { withOperatorTransaction } from "./index";
import { normalizeEmail } from "../users/service";

export async function bootstrapAdminUser(
  email: string,
  name: string,
  passwordHash: string,
): Promise<void> {
  await withOperatorTransaction(async (client) => {
    const normalizedEmail = normalizeEmail(email);
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE normalized_email = $1",
      [normalizedEmail],
    );
    if (existing.rows.length > 0) return;

    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO users
         (id, email, normalized_email, name, password_hash, is_admin, platform_role, status, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, true, 'admin', 'active', NOW())`,
      [id, email.trim(), normalizedEmail, name, passwordHash],
    );
    await client.query(
      "INSERT INTO accounts (id, display_name) VALUES ($1, $2)",
      [`personal:${id}`, name.trim() || normalizedEmail],
    );
    await client.query(
      `INSERT INTO account_memberships (account_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [`personal:${id}`, id],
    );

    rootLogger.info({ email: normalizedEmail }, "Admin user created");
  });
}
