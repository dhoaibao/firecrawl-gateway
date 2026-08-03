import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AppConfigService } from "../config/config.service";
import { disconnectPrisma, initializePrisma } from "../../infrastructure/database";

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly runtime: PrismaClient;
  readonly operator: PrismaClient;

  constructor(config: AppConfigService) {
    const clients = initializePrisma(config.databaseUrl, config.operatorDatabaseUrl);
    this.runtime = clients.runtime;
    this.operator = clients.operator;
  }

  async onModuleInit(): Promise<void> {
    await Promise.all([this.runtime.$connect(), this.operator.$connect()]);
  }

  async onModuleDestroy(): Promise<void> {
    await disconnectPrisma();
  }
}
