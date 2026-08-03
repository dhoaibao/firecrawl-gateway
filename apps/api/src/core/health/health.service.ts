import { Injectable } from "@nestjs/common";
import { DatabaseReadinessService } from "../database/database-readiness.service";

@Injectable()
export class HealthService {
  constructor(private readonly databaseReadiness: DatabaseReadinessService) {}

  async isDatabaseReady(): Promise<boolean> {
    try {
      await this.databaseReadiness.assertReady();
      return true;
    } catch {
      return false;
    }
  }
}
