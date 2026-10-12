import { Module } from "@nestjs/common";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { UserCloudKeysModule } from "../user-cloud-keys/user-cloud-keys.module";
import { UsersModule } from "../users/users.module";
import { UsersAdminController } from "./users-admin.controller";
import { UsersAdminService } from "./users-admin.service";

// AuthModule (the admin guard) and PrismaModule are global.
@Module({
  imports: [UsersModule, ApiKeysModule, UserCloudKeysModule],
  controllers: [UsersAdminController],
  providers: [UsersAdminService],
})
export class UsersAdminModule {}
