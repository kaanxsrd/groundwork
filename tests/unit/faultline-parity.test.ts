// PLAN.md Phase 1 is done when Faultline's in-memory limiter could be swapped for groundwork with
// no loss of features. This test runs a model of that limiter next to groundwork over random
// traffic and compares every answer.
//
// The model, written from its documented behaviour: fixed windows per key that start at the
// key's first request, `cost` per call, `remaining`, and `retryAfter` in whole seconds. One
// difference is deliberate: the model counts denied requests (so a denied big batch burns the
// rest of the window); groundwork doesn't.
import { describe, expect, test } from "bun:test";
import { createRateLimiter, memoryStore } from "../../src/rate-limit/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { T0, TEST_SECRET } from "../support/rate-limit-conformance.ts";

function referenceLimiter(now: () => number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string, max: number, windowMs: number, cost: number) => {
    let w = windows.get(key);
    if (!w || now() - w.start >= windowMs) {
      w = { start: now(), count: 0 };
      windows.set(key, w);
    }
    w.count += cost;
    return {
      ok: w.count <= max,
      retryAfter: Math.ceil((w.start + windowMs - now()) / 1000),
      remaining: Math.max(0, max - w.count),
    };
  };
}

/** Small deterministic PRNG, so a failure can be replayed. */
function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

const USAGES = [
  // Faultline's three call sites: heartbeats, API tokens and batched ingest.
  { name: "hb", max: 60, windowMs: 60_000 },
  { name: "api", max: 300, windowMs: 60_000 },
  { name: "ingest", max: 1_000, windowMs: 60_000 },
] as const;

describe("parity with a hand-rolled in-memory fixed window (Faultline)", () => {
  test.each([1, 2, 3, 4, 5])("cost-1 traffic gets identical answers (seed %d)", async (seed) => {
    const random = prng(seed);
    const clock = createTestClock(T0);
    const reference = referenceLimiter(() => clock.now().getTime());
    const limiter = createRateLimiter({
      store: memoryStore({ clock }),
      secret: TEST_SECRET,
      clock,
    });
    const rules = USAGES.map((u) => limiter.rule({ name: u.name, limit: u.max, window: "1m" }));

    for (let i = 0; i < 3_000; i++) {
      const u = Math.floor(random() * USAGES.length);
      const usage = USAGES[u]!;
      const key = `k${Math.floor(random() * 3)}`;
      clock.advance(Math.floor(random() * 120));
      const expected = reference(`${usage.name}:${key}`, usage.max, usage.windowMs, 1);
      const actual = await rules[u]!.check(key);
      expect(actual.allowed).toBe(expected.ok);
      expect(actual.remaining).toBe(expected.remaining);
      if (!actual.allowed) expect(Math.ceil(actual.retryAfterMs / 1000)).toBe(expected.retryAfter);
    }
  });

  test.each([1, 2, 3])(
    "batched traffic is never stricter, and never lets more through per window (seed %d)",
    async (seed) => {
      const random = prng(seed);
      const clock = createTestClock(T0);
      const reference = referenceLimiter(() => clock.now().getTime());
      const limiter = createRateLimiter({
        store: memoryStore({ clock }),
        secret: TEST_SECRET,
        clock,
      });
      const rule = limiter.rule({ name: "ingest", limit: 100, window: "1m" });

      let windowStart = clock.now().getTime();
      let spentInWindow = 0;
      let referenceAllowed = 0;
      let groundworkAllowed = 0;
      for (let i = 0; i < 2_000; i++) {
        clock.advance(Math.floor(random() * 200));
        if (clock.now().getTime() - windowStart >= 60_000) {
          windowStart = clock.now().getTime();
          spentInWindow = 0;
        }
        const cost = 1 + Math.floor(random() * 30);
        if (reference("ingest", 100, 60_000, cost).ok) referenceAllowed += cost;
        const result = await rule.check("project", { cost });
        if (result.allowed) {
          groundworkAllowed += cost;
          spentInWindow += cost;
        }
        expect(spentInWindow).toBeLessThanOrEqual(100);
      }
      // A denied batch burns the reference's window; groundwork keeps the rest for smaller batches.
      expect(groundworkAllowed).toBeGreaterThan(referenceAllowed);
    },
  );
});
