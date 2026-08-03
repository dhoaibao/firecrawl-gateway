import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { healthSchema } from "@firecrawl/contracts";
import { HealthService } from "./health.service";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("health")
  checkHealth() {
    return healthSchema.parse({ status: "ok" });
  }

  @Get("ready")
  async checkReadiness() {
    if (await this.health.isDatabaseReady()) {
      return healthSchema.parse({ status: "ready", checks: { database: "ok" } });
    }

    throw new ServiceUnavailableException(
      healthSchema.parse({ status: "not_ready", checks: { database: "error" } }),
    );
  }
}
