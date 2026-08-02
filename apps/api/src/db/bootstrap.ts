import crypto from "node:crypto";
import { withOperatorTransaction } from "../infrastructure/database";
import { normalizeEmail } from "../users/service";
import { rootLogger } from "../logger";

export async function bootstrapAdminUser(
  email: string,
  name: string,
  passwordHash: string,
): Promise<void> {
  await withOperatorTransaction(async (tx) => {
    const normalizedEmail = normalizeEmail(email);
    const existing = await tx.user.findUnique({ where: { normalizedEmail }, select: { id: true } });
    if (existing) return;

    const id = crypto.randomUUID();
    await tx.user.create({
      data: {
        id,
        email: email.trim(),
        normalizedEmail,
        name,
        passwordHash,
        isAdmin: true,
        platformRole: "admin",
        status: "active",
        emailVerifiedAt: new Date(),
      },
    });
    await tx.account.create({ data: { id: `personal:${id}`, displayName: name.trim() || normalizedEmail } });
    await tx.accountMembership.create({ data: { accountId: `personal:${id}`, userId: id, role: "owner" } });

    rootLogger.info({ email: normalizedEmail }, "Admin user created");
  });
}
