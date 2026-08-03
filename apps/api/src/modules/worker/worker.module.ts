import { Module } from "@nestjs/common";
import { CoreConfigModule } from "../../core/config/config.module";
import { RateLimitModule } from "../../core/rate-limit/rate-limit.module";
import { QuotaModule } from "../quota/quota.module";
import { QuotaWorkerService } from "./quota-worker.service";
import { WorkerHeartbeatService } from "./worker-heartbeat.service";

@Module({ imports: [CoreConfigModule, RateLimitModule, QuotaModule], providers: [QuotaWorkerService, WorkerHeartbeatService] })
export class WorkerModule {}
