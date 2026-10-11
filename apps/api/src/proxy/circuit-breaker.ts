export type CircuitState = "closed" | "open" | "half-open";

interface Permit {
  kind: "closed" | "probe";
  generation: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit; 0 disables the breaker entirely. */
  failureThreshold: number;
  /** How long the circuit stays open before a single probe request is allowed. */
  cooldownMs: number;
  /** Called on every state change, after the state has been updated. */
  onTransition?: (from: CircuitState, to: CircuitState) => void;
  /** Called for each call rejected without running (circuit open or probe already in flight). */
  onReject?: () => void;
  now?: () => number;
}

/**
 * A small in-process circuit breaker: `closed` -> `open` after N consecutive
 * failures -> `half-open` once the cooldown elapses, where exactly one probe is
 * allowed through; its outcome closes or re-opens the circuit. State is per
 * instance by design, so it needs no shared store.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  /**
   * Bumped every time the circuit opens. A call carries the generation it was
   * admitted under, so a slow call that started before the circuit opened can
   * never count against (or for) it after it has recovered.
   */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /**
   * Runs `call` unless the circuit rejects it, in which case `shortCircuit()` is
   * returned and `call` never runs. `isFailure` classifies the call's result.
   */
  async execute<T>(
    call: () => Promise<T>,
    isFailure: (result: T) => boolean,
    shortCircuit: () => T,
  ): Promise<T> {
    if (this.options.failureThreshold <= 0) return call();
    const permit = this.acquire();
    if (permit === "reject") {
      this.options.onReject?.();
      return shortCircuit();
    }
    let failed = true;
    try {
      const result = await call();
      failed = isFailure(result);
      return result;
    } finally {
      this.release(permit, failed);
    }
  }

  private acquire(): Permit | "reject" {
    if (this.state === "closed") return { kind: "closed", generation: this.generation };
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.options.cooldownMs) return "reject";
      this.transition("half-open");
    }
    // half-open: a single probe at a time; everything else keeps failing fast.
    if (this.probeInFlight) return "reject";
    this.probeInFlight = true;
    return { kind: "probe", generation: this.generation };
  }

  private release(permit: Permit, failed: boolean): void {
    if (permit.kind === "probe") {
      this.probeInFlight = false;
      if (failed) this.open();
      else {
        this.consecutiveFailures = 0;
        this.transition("closed");
      }
      return;
    }
    // A call admitted before the circuit last opened says nothing about the
    // backend now, even if it finishes after the circuit has closed again.
    if (permit.generation !== this.generation || this.state !== "closed") return;
    if (!failed) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.options.failureThreshold) this.open();
  }

  private open(): void {
    this.generation += 1;
    this.openedAt = this.now();
    this.transition("open");
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.options.onTransition?.(from, to);
  }
}
