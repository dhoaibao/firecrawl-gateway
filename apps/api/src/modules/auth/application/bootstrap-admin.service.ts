import crypto from "node:crypto";
import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import { AppConfigService } from "../../../core/config/config.service";
import { TransactionService } from "../../../core/database/transaction.service";
import { validatePassword } from "../../../auth/password";

@Injectable()
export class BootstrapAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapAdminService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly transactions: TransactionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = this.config.adminEmail.trim().toLowerCase();
    const password = this.config.adminPassword;

    if (!email && !password) return;
    if (!email) throw new Error("ADMIN_EMAIL must be set when ADMIN_PASSWORD is configured");

    const existing = await this.transactions.runAsOperator((transaction) => transaction.user.findUnique({
      where: { normalizedEmail: email },
      select: { id: true },
    }));
    if (existing) {
      this.logger.log("Bootstrap admin account already exists; no account changes were made");
      return;
    }
    if (!password) {
      this.logger.warn("Bootstrap admin account was not created because ADMIN_PASSWORD is not configured");
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) throw new Error(`ADMIN_PASSWORD is invalid: ${passwordError}`);
    const passwordHash = await bcrypt.hash(password, this.config.bcryptRounds);

    try {
      const created = await this.transactions.runAsOperator(async (transaction) => {
        const current = await transaction.user.findUnique({
          where: { normalizedEmail: email },
          select: { id: true },
        });
        if (current) return false;

        const userId = crypto.randomUUID();
        const accountId = `personal:${userId}`;
        await transaction.user.create({
          data: {
            id: userId,
            email,
            normalizedEmail: email,
            name: "Administrator",
            passwordHash,
            isAdmin: true,
            platformRole: "admin",
            status: "active",
            emailVerifiedAt: new Date(),
          },
        });
        await transaction.account.create({ data: { id: accountId, displayName: "Administrator" } });
        await transaction.accountMembership.create({ data: { accountId, userId, role: "owner" } });
        return true;
      });

      if (created) this.logger.log("Bootstrap admin account created");
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        this.logger.warn("Bootstrap admin account was not created because another account already uses that email");
        return;
      }
      throw error;
    }
  }
}
