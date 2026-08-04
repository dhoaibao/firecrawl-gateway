import { Module } from "@nestjs/common";
import { EmailModule } from "../email/email.module";
import { APP_GUARD } from "@nestjs/core";
import { AuthAttemptService } from "./application/auth-attempt.service";
import { AuthService } from "./application/auth.service";
import { BootstrapAdminService } from "./application/bootstrap-admin.service";
import { PrismaSessionStore } from "./infrastructure/prisma-session.store";
import { AuthController } from "./presentation/auth.controller";
import { AuthEnabledGuard } from "./presentation/auth-enabled.guard";
import { AuthGuard } from "./presentation/auth.guard";
import { CsrfGuard } from "./presentation/csrf.guard";

@Module({
  imports: [EmailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    BootstrapAdminService,
    AuthAttemptService,
    AuthEnabledGuard,
    AuthGuard,
    PrismaSessionStore,
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [AuthService, AuthGuard, PrismaSessionStore],
})
export class AuthModule {}
