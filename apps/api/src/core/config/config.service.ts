import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Environment } from "./environment.schema";

@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  get authEnabled(): boolean {
    return this.config.get("AUTH_ENABLED", { infer: true });
  }

  get adminEmail(): string {
    return this.config.get("ADMIN_EMAIL", { infer: true });
  }

  get authEncryptionKey(): string {
    return this.config.get("AUTH_ENCRYPTION_KEY", { infer: true });
  }

  get providerCredentialsEncryptionKey(): string {
    return this.config.get("PROVIDER_CREDENTIALS_ENCRYPTION_KEY", { infer: true });
  }

  get cloudBaseUrl(): string {
    return this.config.get("CLOUD_BASE_URL", { infer: true }).replace(/\/+$/, "");
  }

  get brevoWebhookToken(): string {
    return this.config.get("BREVO_WEBHOOK_TOKEN", { infer: true });
  }

  get workerHeartbeatFile(): string {
    return this.config.get("WORKER_HEARTBEAT_FILE", { infer: true });
  }

  get bcryptRounds(): number {
    return this.config.get("BCRYPT_ROUNDS", { infer: true });
  }

  get corsOrigins(): string[] {
    return this.config.get("CORS_ORIGIN", { infer: true })
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
  }

  get databaseUrl(): string {
    return this.config.get("DATABASE_URL", { infer: true });
  }

  get host(): string {
    return this.config.get("HOST", { infer: true });
  }

  get nodeEnvironment(): Environment["NODE_ENV"] {
    return this.config.get("NODE_ENV", { infer: true });
  }

  get port(): number {
    return this.config.get("PORT", { infer: true });
  }

  get publicAppUrl(): string {
    return this.config.get("PUBLIC_APP_URL", { infer: true });
  }

  get registrationEnabled(): boolean {
    return this.config.get("REGISTRATION_ENABLED", { infer: true });
  }

  get sessionCookieName(): string {
    return this.nodeEnvironment === "production" ? "__Host-firecrawl.sid" : "firecrawl.sid";
  }

  get sessionSecret(): string {
    return this.config.get("SESSION_SECRET", { infer: true });
  }

  get sessionSecure(): boolean | "auto" {
    return this.nodeEnvironment === "production"
      ? true
      : this.config.get("SESSION_SECURE", { infer: true });
  }

  get trustProxy(): Environment["TRUST_PROXY"] {
    return this.config.get("TRUST_PROXY", { infer: true });
  }
}
