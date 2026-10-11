import { Module } from "@nestjs/common";
import { UsersModule } from "../users/users.module";
import { PortalAuthController } from "./portal-auth.controller";
import { UserGuard } from "./user.guard";

@Module({
  imports: [UsersModule],
  controllers: [PortalAuthController],
  providers: [UserGuard],
  exports: [UserGuard, UsersModule],
})
export class PortalAuthModule {}
