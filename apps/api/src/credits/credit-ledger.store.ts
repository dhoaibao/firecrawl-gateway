import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { API_CONFIG } from "../common/config.provider";
import type { ApiConfig } from "../common/config";

export const REDIS_CLIENT = "REDIS_CLIENT";

export interface RedisCommandClient {
  isOpen: boolean;
  connect(): Promise<void>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  quit(): Promise<unknown>;
}

export type LedgerReserveResult =
  | { kind: "reserved"; index: number; sequence: number; reservationKey: string }
  | { kind: "no-capacity" }
  | { kind: "unavailable" };

export interface LedgerSnapshot {
  available: boolean;
  sequence: number;
}

const RESERVE_SCRIPT = `
local candidateCount = #KEYS / 3
local now = tonumber(ARGV[1])
local amount = tonumber(ARGV[2])
local reservationTtlSeconds = tonumber(ARGV[3]) or 300
local random = tonumber(ARGV[4]) or 0
local msPerDay = 86400000
local bestDay = nil
local bestCredits = -1
local ties = {}
local initialized = false

-- Selection rule: earliest renewal day first (unknown renewal sorts last), then
-- most remaining credits, then a random pick among exact ties.
for i = 1, candidateCount do
  local pool = KEYS[i]
  local creditsRaw = redis.call('HGET', pool, 'credits')
  if creditsRaw then
    initialized = true
    local credits = tonumber(creditsRaw) or 0
    local disabled = redis.call('HGET', pool, 'disabled') == '1'
    local cooldownUntil = tonumber(redis.call('HGET', pool, 'cooldownUntil') or '0') or 0
    if not disabled and cooldownUntil <= now and credits >= amount then
      local renewsAt = tonumber(redis.call('HGET', pool, 'renewsAt') or '0') or 0
      local day = math.huge
      if renewsAt > 0 then day = math.floor(renewsAt / msPerDay) end
      if bestDay == nil or day < bestDay or (day == bestDay and credits > bestCredits) then
        bestDay = day
        bestCredits = credits
        ties = { i }
      elseif day == bestDay and credits == bestCredits then
        ties[#ties + 1] = i
      end
    end
  end
end

local selected = 0
if #ties > 0 then selected = ties[math.floor(random * #ties) + 1] or ties[1] end

if not initialized then return {-1, 0} end
if selected == 0 then return {0, 0} end

local pool = KEYS[selected]
local reservations = KEYS[candidateCount + selected]
local reservation = KEYS[(candidateCount * 2) + selected]
local sequence = redis.call('HINCRBY', pool, 'reserveSequence', 1)
redis.call('HINCRBY', pool, 'credits', -amount)
redis.call('HINCRBY', pool, 'reserved', amount)
redis.call('HSET', reservation, 'amount', amount, 'sequence', sequence, 'state', 'open')
redis.call('EXPIRE', reservation, reservationTtlSeconds)
redis.call('ZADD', reservations, sequence, reservation)
redis.call('HSET', pool, 'updatedAt', now)
return {selected, sequence, reservation}
`;

const CAPTURE_SCRIPT = `
return redis.call('HGET', KEYS[1], 'reserveSequence') or '0'
`;

const SETTLE_SCRIPT = `
local pool = KEYS[1]
local reservation = KEYS[2]
local reservations = KEYS[3]
local action = ARGV[1]
local cooldownUntil = tonumber(ARGV[2] or '0') or 0
local state = redis.call('HGET', reservation, 'state')
local settled = 0
if state == 'open' then
  local amount = tonumber(redis.call('HGET', reservation, 'amount') or '0') or 0
  local reconciled = redis.call('HGET', reservation, 'reconciled') == '1'
  redis.call('HSET', reservation, 'state', action)
  redis.call('ZREM', reservations, reservation)
  redis.call('HINCRBY', pool, 'reserved', -amount)
  if not reconciled then redis.call('HINCRBY', pool, 'credits', amount) end
  settled = 1
end
redis.call('DEL', reservation)
if action == 'cooldown' then
  local currentCooldown = tonumber(redis.call('HGET', pool, 'cooldownUntil') or '0') or 0
  if cooldownUntil > currentCooldown then redis.call('HSET', pool, 'cooldownUntil', cooldownUntil) end
end
if action == 'disabled' then
  redis.call('HSET', pool, 'disabled', '1', 'credits', '0', 'cooldownUntil', '0')
end
return settled
`;

const ACTUAL_USAGE_SCRIPT = `
local pool = KEYS[1]
local reservation = KEYS[2]
local reservations = KEYS[3]
local actual = tonumber(ARGV[1]) or -1
if actual < 0 then return 0 end
local state = redis.call('HGET', reservation, 'state')
if state ~= 'open' then
  redis.call('DEL', reservation)
  return 0
end
local estimated = tonumber(redis.call('HGET', reservation, 'amount') or '0') or 0
local delta = actual - estimated
if delta > 0 then
  local credits = tonumber(redis.call('HGET', pool, 'credits') or '0') or 0
  local deduction = math.min(delta, math.max(0, credits))
  if deduction > 0 then redis.call('HINCRBY', pool, 'credits', -deduction) end
elseif delta < 0 then
  redis.call('HINCRBY', pool, 'credits', -delta)
end
redis.call('HINCRBY', pool, 'reserved', -estimated)
redis.call('ZREM', reservations, reservation)
redis.call('DEL', reservation)
return 1
`;

const RECONCILE_SCRIPT = `
local pool = KEYS[1]
local reservations = KEYS[2]
local snapshot = tonumber(ARGV[1]) or 0
local snapshotSequence = tonumber(ARGV[2]) or 0
local now = ARGV[3]
local renewsAt = tonumber(ARGV[4]) or 0
local pending = 0
local outstanding = 0
local ids = redis.call('ZRANGE', reservations, 0, -1)

for _, reservation in ipairs(ids) do
  local state = redis.call('HGET', reservation, 'state')
  if state == 'open' then
    local amount = tonumber(redis.call('HGET', reservation, 'amount') or '0') or 0
    local sequence = tonumber(redis.call('HGET', reservation, 'sequence') or '0') or 0
    if sequence > snapshotSequence then
      pending = pending + amount
      outstanding = outstanding + amount
    else
      redis.call('HSET', reservation, 'state', 'reconciled', 'reconciled', '1')
      redis.call('ZREM', reservations, reservation)
      redis.call('DEL', reservation)
    end
  else
    redis.call('ZREM', reservations, reservation)
    redis.call('DEL', reservation)
  end
end

local credits = snapshot - pending
if credits < 0 then credits = 0 end
local disabled = snapshot <= 0 and '1' or '0'
local cooldownUntil = tonumber(redis.call('HGET', pool, 'cooldownUntil') or '0') or 0
if cooldownUntil <= tonumber(now) then cooldownUntil = 0 end
redis.call('HSET', pool, 'credits', credits, 'authoritative', snapshot, 'initialized', '1', 'disabled', disabled, 'cooldownUntil', cooldownUntil, 'reserved', outstanding, 'renewsAt', renewsAt, 'updatedAt', now)
return credits
`;

function asNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Redis operation timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

@Injectable()
export class RedisCreditLedgerStore implements OnModuleDestroy {
  private readonly keyPrefix = "firecrawl-gateway:credit-ledger:v1";
  private connecting?: Promise<void>;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(REDIS_CLIENT) private readonly client: RedisCommandClient | null,
  ) {}

  async reserve(keyIds: string[], amount: number): Promise<LedgerReserveResult> {
    if (!keyIds.length || !this.client) return { kind: "unavailable" };
    const poolKeys = keyIds.map((keyId) => this.poolKey(keyId));
    const reservationKeys = keyIds.map(() => this.reservationKey());
    const reservationSetKeys = keyIds.map((keyId) => this.reservationSetKey(keyId));
    const result = await this.run((client) =>
      client.eval(RESERVE_SCRIPT, {
        keys: [...poolKeys, ...reservationSetKeys, ...reservationKeys],
        arguments: [
          String(Date.now()),
          String(amount),
          String(this.reservationTtlSeconds()),
          String(Math.random()),
        ],
      }),
    );
    if (!result.available) return { kind: "unavailable" };
    const values = Array.isArray(result.value) ? result.value : [];
    const index = asNumber(values[0]);
    const sequence = asNumber(values[1]);
    if (index === null || sequence === null) return { kind: "unavailable" };
    if (index < 0) return { kind: "unavailable" };
    if (index === 0) return { kind: "no-capacity" };
    const reservationKey = typeof values[2] === "string" ? values[2] : null;
    if (!reservationKey) return { kind: "unavailable" };
    return { kind: "reserved", index: index - 1, sequence, reservationKey };
  }

  async capture(keyId: string): Promise<LedgerSnapshot> {
    if (!this.client) return { available: false, sequence: 0 };
    const result = await this.run((client) =>
      client.eval(CAPTURE_SCRIPT, { keys: [this.poolKey(keyId)], arguments: [] }),
    );
    if (!result.available) return { available: false, sequence: 0 };
    return { available: true, sequence: asNumber(result.value) ?? 0 };
  }

  async settleActualUsage(
    keyId: string,
    reservationKey: string,
    actualCredits: number,
  ): Promise<boolean> {
    if (!this.client || !Number.isSafeInteger(actualCredits) || actualCredits < 0) return false;
    const result = await this.run((client) =>
      client.eval(ACTUAL_USAGE_SCRIPT, {
        keys: [this.poolKey(keyId), reservationKey, this.reservationSetKey(keyId)],
        arguments: [String(actualCredits)],
      }),
    );
    return result.available && asNumber(result.value) === 1;
  }

  async reconcile(
    keyId: string,
    remainingCredits: number,
    snapshotSequence: number,
    renewsAtMs = 0,
  ): Promise<boolean> {
    if (!this.client) return false;
    const result = await this.run((client) =>
      client.eval(RECONCILE_SCRIPT, {
        keys: [this.poolKey(keyId), this.reservationSetKey(keyId)],
        arguments: [
          String(Math.max(0, remainingCredits)),
          String(snapshotSequence),
          String(Date.now()),
          String(Number.isFinite(renewsAtMs) && renewsAtMs > 0 ? Math.floor(renewsAtMs) : 0),
        ],
      }),
    );
    return result.available && asNumber(result.value) !== null;
  }

  async settle(
    keyId: string,
    reservationKey: string,
    action: "refund" | "cooldown" | "disabled",
    cooldownUntil = 0,
  ): Promise<boolean> {
    if (!this.client) return false;
    const result = await this.run((client) =>
      client.eval(SETTLE_SCRIPT, {
        keys: [this.poolKey(keyId), reservationKey, this.reservationSetKey(keyId)],
        arguments: [action, String(cooldownUntil)],
      }),
    );
    return result.available && asNumber(result.value) === 1;
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client?.isOpen) return;
    try {
      await withTimeout(this.client.quit(), 500);
    } catch {
      /* best effort during shutdown */
    }
  }

  private poolKey(keyId: string): string {
    return `${this.keyPrefix}:pool:${keyId}`;
  }
  private reservationSetKey(keyId: string): string {
    return `${this.keyPrefix}:reservations:${keyId}`;
  }
  private reservationKey(reservationId?: string): string {
    return `${this.keyPrefix}:reservation:${reservationId || randomUUID()}`;
  }

  private reservationTtlSeconds(): number {
    const requestTimeoutMs = this.config.requestTimeoutMs || 120_000;
    return Math.max(300, Math.ceil((requestTimeoutMs + 60_000) / 1000));
  }

  private async run<T>(
    operation: (client: RedisCommandClient) => Promise<T>,
  ): Promise<{ available: boolean; value?: T }> {
    if (!this.client || !this.config.redisUrl) return { available: false };
    try {
      if (!this.client.isOpen) {
        if (!this.connecting)
          this.connecting = withTimeout(this.client.connect(), 750).finally(() => {
            this.connecting = undefined;
          });
        await this.connecting;
      }
      return { available: true, value: await withTimeout(operation(this.client), 750) };
    } catch {
      return { available: false };
    }
  }
}
