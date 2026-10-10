import { Inject, Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";
import { decryptSettingValue } from "../common/crypto";
import { RedisCreditLedgerStore } from "./credit-ledger.store";

export interface CreditUsageDetails {
  remainingCredits: number | null;
  planCredits: number | null;
  billingPeriodStart: string | null;
  billingPeriodEnd: string | null;
  error?: string;
}

export interface CreditReservation {
  key: string;
  keyId: string;
  amount: number;
  source: "redis" | "local";
  reservationKey?: string;
}

const CREDIT_USAGE_CACHE_TTL_MS = 30_000;
const CREDIT_KEY_COOLDOWN_MS = 30_000;
const REDIS_FAILURE_COOLDOWN_MS = 5_000;
const MS_PER_DAY = 86_400_000;
const CREDITS_USED_KEY = "creditsUsed";
const METADATA_KEY = "metadata";
const MAX_SAFE_CREDITS_USED = Number.MAX_SAFE_INTEGER;
const KEY_ID_CACHE_LIMIT = 256;
const MAX_SCANNED_KEY_LENGTH = Math.max(CREDITS_USED_KEY.length, METADATA_KEY.length);

type CreditsUsedScanState =
  "outside" | "string" | "after-key" | "after-colon" | "digits" | "after-digits";

class CreditsUsedScanner {
  private state: CreditsUsedScanState = "outside";
  private escaped = false;
  private candidate = "";
  private hasEscape = false;
  private pendingKey: string | null = null;
  private value = 0;
  private overflow = false;
  private found = false;
  private objectDepth = 0;
  private arrayDepth = 0;
  private metadataObjectDepth: number | null = null;
  private metadataArrayDepth: number | null = null;

  constructor(private readonly onFound: (creditsUsed: number) => void) {}

  push(chunk: Uint8Array): void {
    if (this.found) return;
    const length = chunk.length;
    // Next quote/backslash positions in this chunk. -2: not searched yet, -1: none in the rest.
    // Each is searched again only once consumed, so the scan stays linear in the chunk size.
    let nextQuote = -2;
    let nextBackslash = -2;
    let i = 0;
    while (i < length) {
      if (this.state === "string" && !this.escaped) {
        // Skip to the next quote or backslash instead of stepping through every string byte.
        if (nextQuote !== -1 && nextQuote < i) nextQuote = chunk.indexOf(34, i);
        if (nextBackslash !== -1 && nextBackslash < i) nextBackslash = chunk.indexOf(92, i);
        let end = nextQuote === -1 ? length : nextQuote;
        if (nextBackslash !== -1 && nextBackslash < end) end = nextBackslash;
        for (let j = i; j < end && this.candidate.length <= MAX_SCANNED_KEY_LENGTH; j++) {
          const byte = chunk[j];
          this.candidate += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "\\0";
        }
        i = end;
        if (i >= length) return;
      }
      const byte = chunk[i++];
      let processAgain = true;
      while (processAgain && !this.found) processAgain = this.processByte(byte);
      if (this.found) return;
    }
  }

  finish(): void {}

  private processByte(byte: number): boolean {
    if (this.state === "outside") {
      if (byte === 34) {
        this.state = "string";
        this.candidate = "";
        this.hasEscape = false;
      } else {
        this.updateContainerDepth(byte);
      }
      return false;
    }

    if (this.state === "string") {
      if (this.escaped) {
        this.escaped = false;
        this.hasEscape = true;
        return false;
      }
      if (byte === 92) {
        this.escaped = true;
        this.hasEscape = true;
        return false;
      }
      if (byte === 34) {
        this.pendingKey = this.hasEscape ? null : this.candidate;
        this.state = "after-key";
        return false;
      }
      if (this.candidate.length <= MAX_SCANNED_KEY_LENGTH) {
        this.candidate += byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : "\\0";
      }
      return false;
    }

    if (this.state === "after-key") {
      if (isJsonWhitespace(byte)) return false;
      if (byte === 58) {
        this.state = "after-colon";
        return false;
      }
      this.pendingKey = null;
      this.state = "outside";
      return true;
    }

    if (this.state === "after-colon") {
      if (isJsonWhitespace(byte)) return false;
      if (byte === 123 || byte === 91) {
        const metadataValue =
          this.pendingKey === METADATA_KEY &&
          this.objectDepth === 1 &&
          this.arrayDepth === 0 &&
          byte === 123;
        this.updateContainerDepth(byte);
        if (metadataValue) {
          this.metadataObjectDepth = this.objectDepth;
          this.metadataArrayDepth = this.arrayDepth;
        }
        this.pendingKey = null;
        this.state = "outside";
        return false;
      }
      if (
        byte >= 48 &&
        byte <= 57 &&
        this.pendingKey === CREDITS_USED_KEY &&
        this.metadataObjectDepth === this.objectDepth &&
        this.metadataArrayDepth === this.arrayDepth
      ) {
        this.state = "digits";
        this.value = byte - 48;
        this.overflow = false;
        this.pendingKey = null;
        return false;
      }
      this.pendingKey = null;
      this.state = "outside";
      return true;
    }

    if (this.state === "digits") {
      if (byte >= 48 && byte <= 57) {
        const digit = byte - 48;
        if (this.value > Math.floor((MAX_SAFE_CREDITS_USED - digit) / 10)) this.overflow = true;
        else if (!this.overflow) this.value = this.value * 10 + digit;
        return false;
      }
      if (isJsonWhitespace(byte)) {
        this.state = "after-digits";
        return false;
      }
      if (isJsonDelimiter(byte)) {
        this.emitValue();
        this.updateContainerDepth(byte);
        this.state = "outside";
        return false;
      }
      this.state = "outside";
      return true;
    }

    if (isJsonWhitespace(byte)) return false;
    if (isJsonDelimiter(byte)) {
      this.emitValue();
      this.updateContainerDepth(byte);
      this.state = "outside";
      return false;
    }
    this.state = "outside";
    return true;
  }

  private updateContainerDepth(byte: number): void {
    if (byte === 123) this.objectDepth++;
    if (byte === 91) this.arrayDepth++;
    if (byte === 125) {
      if (this.metadataObjectDepth === this.objectDepth) {
        this.metadataObjectDepth = null;
        this.metadataArrayDepth = null;
      }
      this.objectDepth = Math.max(0, this.objectDepth - 1);
    }
    if (byte === 93) this.arrayDepth = Math.max(0, this.arrayDepth - 1);
  }

  private emitValue(): void {
    if (!this.overflow) {
      this.found = true;
      this.onFound(this.value);
    }
  }
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 9 || byte === 10 || byte === 13 || byte === 32;
}

function isJsonDelimiter(byte: number): boolean {
  return byte === 44 || byte === 93 || byte === 125;
}

export function extractCreditsUsed(body: Uint8Array): number | null {
  let creditsUsed: number | null = null;
  new CreditsUsedScanner((value) => {
    creditsUsed = value;
  }).push(body);
  return creditsUsed;
}

export function observeCreditsUsedStream(
  stream: ReadableStream<Uint8Array>,
  onCreditsUsed: (creditsUsed: number) => Promise<void> | void,
): ReadableStream<Uint8Array> {
  const scanner = new CreditsUsedScanner((value) => {
    queueMicrotask(() => {
      void Promise.resolve()
        .then(() => onCreditsUsed(value))
        .catch(() => undefined);
    });
  });
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        scanner.push(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        scanner.finish();
      },
    }),
  );
}

@Injectable()
export class CreditRoutingService {
  private readonly creditUsageInFlight = new Map<string, Promise<CreditUsageDetails>>();
  private readonly creditUsageCache = new Map<
    string,
    { details: CreditUsageDetails; expiresAt: number }
  >();
  private readonly localCooldownUntil = new Map<string, number>();
  private readonly localDisabled = new Set<string>();
  private readonly localPools = new Map<
    string,
    { renewsAt: number | null; credits: number | null }
  >();
  private readonly keyIds = new Map<string, string>();
  private redisUnavailableUntil = 0;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly ledger: RedisCreditLedgerStore,
  ) {}

  keyId(apiKey: string): string {
    const cached = this.keyIds.get(apiKey);
    if (cached !== undefined) return cached;
    const keyId = crypto
      .createHmac("sha256", Buffer.from(this.config.firecrawlKeysEncryptionKey, "hex"))
      .update(apiKey)
      .digest("hex");
    // Bounded so rotated-out keys cannot accumulate indefinitely.
    if (this.keyIds.size >= KEY_ID_CACHE_LIMIT) this.keyIds.clear();
    this.keyIds.set(apiKey, keyId);
    return keyId;
  }

  async reserve(
    apiKeys: string[],
    amount: number,
    excludedKeyIds: ReadonlySet<string> = new Set(),
  ): Promise<CreditReservation | null> {
    const normalizedAmount = Math.max(1, Math.ceil(amount));
    const now = Date.now();
    const candidates = apiKeys
      .map((key) => ({ key, keyId: this.keyId(key) }))
      .filter(({ keyId }) => !excludedKeyIds.has(keyId))
      .filter(
        ({ keyId }) =>
          !this.localDisabled.has(keyId) && (this.localCooldownUntil.get(keyId) || 0) <= now,
      );
    if (!candidates.length) return null;

    if (Date.now() >= this.redisUnavailableUntil) {
      const result = await this.ledger.reserve(
        candidates.map(({ keyId }) => keyId),
        normalizedAmount,
      );
      if (result.kind === "reserved") {
        this.redisUnavailableUntil = 0;
        const selected = candidates[result.index];
        if (selected)
          return {
            ...selected,
            amount: normalizedAmount,
            source: "redis",
            reservationKey: result.reservationKey,
          };
      } else if (result.kind === "no-capacity") {
        return null;
      } else {
        this.redisUnavailableUntil = Date.now() + REDIS_FAILURE_COOLDOWN_MS;
      }
    }

    return this.reserveLocally(candidates, normalizedAmount);
  }

  async recordResponse(
    reservation: CreditReservation,
    status: number,
    actualCreditsUsed?: number,
  ): Promise<void> {
    if (status === 402) {
      this.localDisabled.add(reservation.keyId);
      this.localCooldownUntil.delete(reservation.keyId);
      if (reservation.source === "redis" && reservation.reservationKey) {
        await this.ledger.settle(reservation.keyId, reservation.reservationKey, "disabled");
      }
      return;
    }

    if (status === 429) {
      const cooldownUntil = Date.now() + CREDIT_KEY_COOLDOWN_MS;
      this.localCooldownUntil.set(reservation.keyId, cooldownUntil);
      if (reservation.source === "redis" && reservation.reservationKey) {
        await this.ledger.settle(
          reservation.keyId,
          reservation.reservationKey,
          "cooldown",
          cooldownUntil,
        );
      }
      return;
    }

    // Authentication failures are rejected before useful work is performed;
    // return their estimate to the pool. Other responses remain reserved until
    // the next authoritative refresh because the upstream may have consumed it.
    if (
      (status === 401 || status === 403) &&
      reservation.source === "redis" &&
      reservation.reservationKey
    ) {
      await this.ledger.settle(reservation.keyId, reservation.reservationKey, "refund");
      return;
    }

    if (
      status >= 200 &&
      status < 300 &&
      reservation.source === "redis" &&
      reservation.reservationKey &&
      actualCreditsUsed !== undefined &&
      Number.isSafeInteger(actualCreditsUsed) &&
      actualCreditsUsed >= 0
    ) {
      await this.ledger.settleActualUsage(
        reservation.keyId,
        reservation.reservationKey,
        actualCreditsUsed,
      );
    }
  }

  async refreshCreditUsage(apiKey: string): Promise<CreditUsageDetails> {
    const cached = this.creditUsageCache.get(apiKey);
    if (cached && cached.expiresAt > Date.now()) return cached.details;
    if (cached) this.creditUsageCache.delete(apiKey);

    const existing = this.creditUsageInFlight.get(apiKey);
    if (existing) return existing;

    const request = (async (): Promise<CreditUsageDetails> => {
      const keyId = this.keyId(apiKey);
      const snapshot = await this.ledger.capture(keyId);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        let response: Response;
        try {
          response = await fetch(`${this.config.cloudBaseUrl}/v2/team/credit-usage`, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!response.ok) {
          return {
            remainingCredits: null,
            planCredits: null,
            billingPeriodStart: null,
            billingPeriodEnd: null,
            error: `HTTP ${response.status}: ${(await response.text()) || response.statusText}`,
          };
        }

        const json = (await response.json()) as {
          data?: {
            remainingCredits?: number;
            planCredits?: number;
            billingPeriodStart?: string | null;
            billingPeriodEnd?: string | null;
          };
        };
        const remainingCredits = json.data?.remainingCredits;
        const details: CreditUsageDetails = {
          remainingCredits:
            typeof remainingCredits === "number" && Number.isFinite(remainingCredits)
              ? remainingCredits
              : null,
          planCredits:
            typeof json.data?.planCredits === "number" && Number.isFinite(json.data.planCredits)
              ? json.data.planCredits
              : null,
          billingPeriodStart: json.data?.billingPeriodStart ?? null,
          billingPeriodEnd: json.data?.billingPeriodEnd ?? null,
        };
        if (details.remainingCredits === null)
          return { ...details, error: "Credit usage response did not include remainingCredits" };

        const parsedRenewal = details.billingPeriodEnd
          ? Date.parse(details.billingPeriodEnd)
          : Number.NaN;
        const renewsAt = Number.isFinite(parsedRenewal) && parsedRenewal > 0 ? parsedRenewal : null;
        if (snapshot.available) {
          await this.ledger.reconcile(
            keyId,
            details.remainingCredits,
            snapshot.sequence,
            renewsAt ?? 0,
          );
        }
        this.localPools.set(keyId, { renewsAt, credits: details.remainingCredits });
        if (details.remainingCredits > 0) {
          this.localDisabled.delete(keyId);
          if ((this.localCooldownUntil.get(keyId) || 0) <= Date.now())
            this.localCooldownUntil.delete(keyId);
        } else {
          this.localDisabled.add(keyId);
        }
        return details;
      } catch (error) {
        return {
          remainingCredits: null,
          planCredits: null,
          billingPeriodStart: null,
          billingPeriodEnd: null,
          error: (error as Error).message,
        };
      }
    })();
    this.creditUsageInFlight.set(apiKey, request);
    try {
      const details = await request;
      if (!details.error)
        this.creditUsageCache.set(apiKey, {
          details,
          expiresAt: Date.now() + CREDIT_USAGE_CACHE_TTL_MS,
        });
      return details;
    } finally {
      if (this.creditUsageInFlight.get(apiKey) === request) this.creditUsageInFlight.delete(apiKey);
    }
  }

  async refreshCreditUsageForKeys(apiKeys: string[]): Promise<CreditUsageDetails[]> {
    return Promise.all(apiKeys.map((apiKey) => this.refreshCreditUsage(apiKey)));
  }

  /**
   * Local fallback mirrors the Redis rule: earliest renewal day first (unknown
   * renewal last), then most remaining credits, then a random pick among ties.
   * Renewal/credit data comes from the last successful credit-usage refresh;
   * credits are decremented locally per reservation for ordering only.
   */
  private async reserveLocally(
    candidates: Array<{ key: string; keyId: string }>,
    amount: number,
  ): Promise<CreditReservation | null> {
    const now = Date.now();
    let best: Array<{ key: string; keyId: string }> = [];
    let bestDay = Number.POSITIVE_INFINITY;
    let bestCredits = -1;
    for (const candidate of candidates) {
      if (this.localDisabled.has(candidate.keyId)) continue;
      if ((this.localCooldownUntil.get(candidate.keyId) || 0) > now) continue;
      const pool = this.localPools.get(candidate.keyId);
      const day = pool?.renewsAt
        ? Math.floor(pool.renewsAt / MS_PER_DAY)
        : Number.POSITIVE_INFINITY;
      const credits = pool?.credits ?? -1;
      if (!best.length || day < bestDay || (day === bestDay && credits > bestCredits)) {
        best = [candidate];
        bestDay = day;
        bestCredits = credits;
      } else if (day === bestDay && credits === bestCredits) {
        best.push(candidate);
      }
    }
    if (!best.length) return null;
    const selected = best[Math.floor(Math.random() * best.length)];
    const pool = this.localPools.get(selected.keyId);
    if (pool?.credits !== null && pool?.credits !== undefined)
      pool.credits = Math.max(0, pool.credits - amount);
    return { ...selected, amount, source: "local" };
  }
}

/**
 * Estimates one credit per proxied cloud request. The pathname/body are part
 * of the interface so endpoint-specific modifiers can be added only when the
 * gateway has enough request-level evidence to do so; it intentionally does
 * not guess at Firecrawl's endpoint billing rules.
 */
export function estimateCreditCost(_pathname: string, _body: unknown): number {
  return 1;
}

export function parseCreditKeys(
  value: string,
  encryptionKey: string,
): { keys: string[]; encrypted: boolean } {
  const decrypted = decryptSettingValue(value, encryptionKey);
  const parsed = JSON.parse(decrypted.value) as unknown;
  return {
    keys: Array.isArray(parsed)
      ? parsed.filter((key): key is string => typeof key === "string" && key.length > 0)
      : [],
    encrypted: decrypted.encrypted,
  };
}

export function creditKeyPrefix(apiKey: string): string {
  return `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`;
}
