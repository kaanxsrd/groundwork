import { describe, expect, test } from "bun:test";
import { createRateLimiter, memoryStore } from "../../src/rate-limit/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { rateLimitConformance, T0, TEST_SECRET } from "../support/rate-limit-conformance.ts";

rateLimitConformance(
  "memory store",
  () => (clock, logger) =>
    createRateLimiter({ store: memoryStore({ clock }), secret: TEST_SECRET, clock, logger }),
);

describe("memory store", () => {
  test("forgets the least recently used subject when full", async () => {
    const clock = createTestClock(T0);
    const store = memoryStore({ maxKeys: 2, clock });
    const limiter = createRateLimiter({ store, secret: TEST_SECRET, clock });
    const rule = limiter.rule({ name: "lru", limit: 1, window: "1h" });

    await rule.check("a");
    await rule.check("b");
    expect((await rule.check("a")).allowed).toBe(false); // "a" is now the most recently used
    await rule.check("c"); // evicts "b"
    expect(store.size).toBe(2);
    expect((await rule.check("b")).allowed).toBe(true); // forgotten, so counted afresh
    expect((await rule.check("a")).allowed).toBe(true); // evicted by "b" in turn
  });

  test("cleanup removes only expired subjects", async () => {
    const clock = createTestClock(T0);
    const store = memoryStore({ clock });
    const limiter = createRateLimiter({ store, secret: TEST_SECRET, clock });
    const short = limiter.rule({ name: "short", limit: 5, window: "1m" });
    const long = limiter.rule({ name: "long", limit: 5, window: "1h" });
    await short.check("x");
    await long.check("x");
    clock.advance("2m");
    expect(await limiter.cleanup()).toBe(1);
    expect(store.size).toBe(1);
    expect((await long.check("x", { cost: 0 })).remaining).toBe(4);
  });

  test("rejects a bad maxKeys", () => {
    expect(() => memoryStore({ maxKeys: 0 })).toThrow(/maxKeys/);
    expect(() => memoryStore({ maxKeys: 1.5 })).toThrow(/maxKeys/);
  });
});
