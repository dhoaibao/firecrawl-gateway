import { CanActivate, Injectable, NotFoundException } from "@nestjs/common";
import { AppConfigService } from "../../../core/config/config.service";

@Injectable()
export class AuthEnabledGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(): boolean {
    if (!this.config.authEnabled) throw new NotFoundException("Not found");
    return true;
  }
}
