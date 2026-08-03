import { createHash } from "node:crypto";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { RateLimitService } from "../../../core/rate-limit/rate-limit.service";

const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

@Injectable()
export class AuthAttemptService {
  constructor(private readonly rateLimits: RateLimitService) {}

  async allow(scope: "login" | "mfa" | "register" | "verification" | "password-reset", key: string): Promise<boolean> {
    const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 32);
    try {
      const decision = await this.rateLimits.consume(
        [`auth-attempt:${scope}:${fingerprint}`],
        MAX_ATTEMPTS,
        ATTEMPT_WINDOW_MS,
      );
      return decision.allowed;
    } catch {
      throw new ServiceUnavailableException("Rate limiter unavailable");
    }
  }
}
