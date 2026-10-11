import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, type CircuitState } from "./circuit-breaker";

type Result = { ok: boolean };

function makeBreaker(overrides: { failureThreshold?: number; cooldownMs?: number } = {}) {
  let now = 1_000;
  const transitions: Array<[CircuitState, CircuitState]> = [];
  const onReject = vi.fn();
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 10_000,
    ...overrides,
    now: () => now,
    onTransition: (from, to) => transitions.push([from, to]),
    onReject,
  });
  return {
    breaker,
    transitions,
    onReject,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const isFailure = (result: Result) => !result.ok;
const shortCircuit = (): Result => ({ ok: false });

async function run(breaker: CircuitBreaker, ok: boolean, call = vi.fn()) {
  call.mockResolvedValue({ ok });
  const result = await breaker.execute(call, isFailure, shortCircuit);
  return { result, call };
}

describe("CircuitBreaker", () => {
  it("stays closed while failures are not consecutive", async () => {
    const { breaker } = makeBreaker();

    for (const ok of [false, false, true, false, false, true]) await run(breaker, ok);

    expect(breaker.currentState).toBe("closed");
  });

  it("opens after the threshold of consecutive failures and stops calling upstream", async () => {
    const { breaker, transitions, onReject } = makeBreaker();

    for (let i = 0; i < 3; i += 1) await run(breaker, false);
    expect(breaker.currentState).toBe("open");
    expect(transitions).toEqual([["closed", "open"]]);

    const { call, result } = await run(breaker, true);

    expect(call).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("allows a single probe after the cooldown and closes on success", async () => {
    const { breaker, transitions, advance } = makeBreaker();
    for (let i = 0; i < 3; i += 1) await run(breaker, false);

    advance(9_999);
    expect((await run(breaker, true)).call).not.toHaveBeenCalled();

    advance(1);
    const probe = await run(breaker, true);

    expect(probe.call).toHaveBeenCalledTimes(1);
    expect(breaker.currentState).toBe("closed");
    expect(transitions).toEqual([
      ["closed", "open"],
      ["open", "half-open"],
      ["half-open", "closed"],
    ]);
    // A closed circuit counts from zero again.
    await run(breaker, false);
    await run(breaker, false);
    expect(breaker.currentState).toBe("closed");
  });

  it("re-opens and restarts the cooldown when the probe fails", async () => {
    const { breaker, advance } = makeBreaker();
    for (let i = 0; i < 3; i += 1) await run(breaker, false);
    advance(10_000);

    await run(breaker, false); // probe fails
    expect(breaker.currentState).toBe("open");

    advance(9_999);
    expect((await run(breaker, true)).call).not.toHaveBeenCalled();
    advance(1);
    expect((await run(breaker, true)).call).toHaveBeenCalledTimes(1);
    expect(breaker.currentState).toBe("closed");
  });

  it("rejects concurrent calls while the half-open probe is in flight", async () => {
    const { breaker, advance, onReject } = makeBreaker();
    for (let i = 0; i < 3; i += 1) await run(breaker, false);
    advance(10_000);
    let finishProbe!: (result: Result) => void;
    const probeCall = vi.fn(
      () =>
        new Promise<Result>((resolve) => {
          finishProbe = resolve;
        }),
    );

    const probe = breaker.execute(probeCall, isFailure, shortCircuit);
    const concurrent = await run(breaker, true);

    expect(concurrent.call).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(breaker.currentState).toBe("half-open");

    finishProbe({ ok: true });
    await probe;
    expect(breaker.currentState).toBe("closed");
  });

  it("ignores the outcome of a call admitted before the circuit opened", async () => {
    const { breaker } = makeBreaker({ failureThreshold: 2 });
    let finishSlow!: (result: Result) => void;
    const slow = breaker.execute(
      () =>
        new Promise<Result>((resolve) => {
          finishSlow = resolve;
        }),
      isFailure,
      shortCircuit,
    );
    await run(breaker, false);
    await run(breaker, false);
    expect(breaker.currentState).toBe("open");

    finishSlow({ ok: true });
    await slow;

    expect(breaker.currentState).toBe("open");
  });

  it("ignores a stale failure that finishes after the circuit has recovered", async () => {
    const { breaker, advance, transitions } = makeBreaker({ failureThreshold: 1 });
    let failStale!: (result: Result) => void;
    const stale = breaker.execute(
      () =>
        new Promise<Result>((resolve) => {
          failStale = resolve;
        }),
      isFailure,
      shortCircuit,
    );
    await run(breaker, false); // opens the circuit
    advance(10_000);
    await run(breaker, true); // successful probe closes it
    expect(breaker.currentState).toBe("closed");
    transitions.length = 0;

    failStale({ ok: false });
    await stale;

    expect(breaker.currentState).toBe("closed");
    expect(transitions).toEqual([]);
  });

  it("does not let a stale success erase failures counted after recovery", async () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 3 });
    let succeedStale!: (result: Result) => void;
    const stale = breaker.execute(
      () =>
        new Promise<Result>((resolve) => {
          succeedStale = resolve;
        }),
      isFailure,
      shortCircuit,
    );
    for (let i = 0; i < 3; i += 1) await run(breaker, false); // opens
    advance(10_000);
    await run(breaker, true); // probe closes
    await run(breaker, false);
    await run(breaker, false);

    succeedStale({ ok: true });
    await stale;
    await run(breaker, false); // third failure since recovery must still open it

    expect(breaker.currentState).toBe("open");
  });

  it("counts calls admitted after recovery normally", async () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 2 });
    await run(breaker, false);
    await run(breaker, false); // opens
    advance(10_000);
    await run(breaker, true); // closes

    await run(breaker, false);
    expect(breaker.currentState).toBe("closed");
    await run(breaker, false);
    expect(breaker.currentState).toBe("open");
  });

  it("counts a thrown call as a failure and rethrows", async () => {
    const { breaker } = makeBreaker({ failureThreshold: 1 });

    await expect(
      breaker.execute(() => Promise.reject(new Error("boom")), isFailure, shortCircuit),
    ).rejects.toThrow("boom");

    expect(breaker.currentState).toBe("open");
  });

  it("is a transparent pass-through when the threshold is 0", async () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 0 });

    for (let i = 0; i < 10; i += 1) {
      const { call } = await run(breaker, false);
      expect(call).toHaveBeenCalledTimes(1);
    }

    expect(breaker.currentState).toBe("closed");
    expect(transitions).toEqual([]);
  });
});
