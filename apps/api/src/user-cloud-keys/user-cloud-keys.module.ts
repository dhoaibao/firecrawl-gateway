import { Module } from "@nestjs/common";
import { UserCloudKeysService } from "./user-cloud-keys.service";

// PrismaModule and ApiConfigModule are global.
@Module({ providers: [UserCloudKeysService], exports: [UserCloudKeysService] })
export class UserCloudKeysModule {}
