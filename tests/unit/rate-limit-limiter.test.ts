import { describe, expect, test } from "bun:test";
import { isGroundworkError } from "../../src/internal/errors.ts";
import {
  createRateLimiter,
  memoryStore,
  type RateLimitStore,
  type RuleOptions,
} from "../../src/rate-limit/index.ts";
import { STORE_RETRY_MS } from "../../src/rate-limit/limiter.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { recordingLogger, T0, TEST_SECRET } from "../support/rate-limit-conformance.ts";

/** A store that works, fails or hangs on command, and counts calls. */
function controllableStore(clock: ReturnType<typeof createTestClock>) {
  const inner = memoryStore({ clock });
  const state = { mode: "ok" as "ok" | "fail" | "hang", calls: 0, resets: 0 };
  const store: RateLimitStore = {
    kind: "fake",
    consume(input) {
      state.calls++;
      if (state.mode === "fail") {
        return Promise.reject(
          Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        );
      }
      if (state.mode === "hang") return new Promise(() => {});
      return inner.consume(input);
    },
    async reset(key) {
      state.resets++;
      if (state.mode === "fail") throw new Error("reset failed");
      await inner.reset(key);
    },
    cleanup: async () => 7,
  };
  return { store, state };
}

function setup(
  rule: RuleOptions = { name: "r", limit: 3, window: "1m" },
  extra: { timeout?: "50ms" | false } = {},
) {
  const clock = createTestClock(T0);
  const logger = recordingLogger();
  const { store, state } = controllableStore(clock);
  const limiter = createRateLimiter({ store, secret: TEST_SECRET, clock, logger, ...extra });
  return { clock, logger, state, limiter, rule: limiter.rule(rule) };
}

describe("store outages", () => {
  test("stops calling a failed store until the retry period passes, then recovers", async () => {
    const { clock, logger, state, rule } = setup();
    state.mode = "fail";
    expect(await rule.check("a")).toMatchObject({ allowed: true, degraded: "memory" });
    expect(state.calls).toBe(1);

    for (let i = 0; i < 10; i++) await rule.check("b");
    expect(state.calls).toBe(1); // the breaker kept every request away from the dead store

    clock.advance(STORE_RETRY_MS - 1);
    await rule.check("c");
    expect(state.calls).toBe(1);

    state.mode = "ok";
    clock.advance(1);
    expect(await rule.check("d")).toMatchObject({ allowed: true, degraded: false });
    expect(state.calls).toBe(2);
    expect(logger.lines.map((line) => line.level)).toEqual(["error", "info"]);

    // A second outage is logged again.
    state.mode = "fail";
    await rule.check("e");
    expect(logger.lines.map((line) => line.level)).toEqual(["error", "info", "error"]);
  });

  test("the outage log names the store and error, never the subject or secret", async () => {
    const { logger, state, rule } = setup();
    state.mode = "fail";
    await rule.check("198.51.100.7");
    expect(logger.lines[0]?.context).toEqual({
      store: "fake",
      onError: "memory",
      error: { name: "Error", message: "connect ECONNREFUSED", code: "ECONNREFUSED" },
    });
    const logged = JSON.stringify(logger.lines);
    expect(logged).not.toContain("198.51.100.7");
    expect(logged).not.toContain(TEST_SECRET);
  });

  test("memory keeps enforcing the limit during an outage", async () => {
    const { state, rule } = setup({ name: "r", limit: 2, window: "1m" });
    state.mode = "fail";
    const allowed = [];
    for (let i = 0; i < 4; i++) allowed.push((await rule.check("x")).allowed);
    expect(allowed).toEqual([true, true, false, false]);
  });

  test("a per-rule onError overrides the limiter's", async () => {
    const { state, limiter } = setup();
    state.mode = "fail";
    const closed = limiter.rule({ name: "closed", limit: 5, window: "1m", onError: "deny" });
    const open = limiter.rule({ name: "open", limit: 1, window: "1m", onError: "allow" });
    expect(await closed.check("x")).toMatchObject({ allowed: false, degraded: "deny" });
    expect(await open.check("x")).toMatchObject({ allowed: true, degraded: "allow" });
    expect(await open.check("x")).toMatchObject({ allowed: true, degraded: "allow" });
  });

  test('"deny" asks clients to come back when the store will be tried again', async () => {
    const { clock, state, rule } = setup({ name: "r", limit: 5, window: "1h", onError: "deny" });
    state.mode = "fail";
    const first = await rule.check("x");
    expect(first.retryAfterMs).toBe(STORE_RETRY_MS);
    expect(first.headers["Retry-After"]).toBe("5");
    clock.advance(4_500);
    expect((await rule.check("x")).retryAfterMs).toBe(1_000);
  });

  test("a store that hangs times out into the fallback", async () => {
    const { state, rule } = setup(undefined, { timeout: "50ms" });
    state.mode = "hang";
    const started = performance.now();
    expect(await rule.check("x")).toMatchObject({ degraded: "memory" });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("timeout: false waits for the store", async () => {
    const { state, rule } = setup(undefined, { timeout: false });
    state.mode = "hang";
    const outcome = await Promise.race([
      rule.check("x").then(() => "answered"),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 150)),
    ]);
    expect(outcome).toBe("still waiting");
  });

  test("bad arguments throw and are not mistaken for an outage", async () => {
    const { logger, state, rule } = setup();
    await expect(rule.check("x", { cost: -1 })).rejects.toThrow(/Invalid cost/);
    await expect(rule.check(42 as unknown as string)).rejects.toThrow(/subject must be a string/);
    expect(state.calls).toBe(0);
    expect(await rule.check("x")).toMatchObject({ degraded: false });
    expect(logger.lines).toEqual([]);
  });

  test("reset clears the fallback too, and reports store failures", async () => {
    const { state, rule } = setup({ name: "r", limit: 1, window: "1h" });
    state.mode = "fail";
    await rule.check("x");
    expect((await rule.check("x")).allowed).toBe(false);
    await expect(rule.reset("x")).rejects.toThrow("reset failed");
    expect((await rule.check("x")).allowed).toBe(true); // memory forgot it anyway
  });

  test("cleanup returns the store's count", async () => {
    const { limiter } = setup();
    expect(await limiter.cleanup()).toBe(7);
  });
});

describe("createRateLimiter options", () => {
  const store = memoryStore();
  const cases: [string, unknown, RegExp][] = [
    ["no options", undefined, /needs an options object/],
    ["neither db nor store", { secret: TEST_SECRET }, /needs db and table/],
    [
      "db without table",
      { secret: TEST_SECRET, db: { execute: async () => [] } },
      /needs db and table/,
    ],
    [
      "both db and store",
      { secret: TEST_SECRET, store, db: { execute: async () => [] } },
      /either store, or db and table/,
    ],
    ["a short secret", { secret: "short", store }, /at least 32 bytes/],
    ["a bad onError", { secret: TEST_SECRET, store, onError: "retry" }, /Invalid onError/],
    ["a bad timeout", { secret: TEST_SECRET, store, timeout: "0ms" }, /Invalid timeout/],
    ["a bad memory size", { secret: TEST_SECRET, store, memory: { maxKeys: -1 } }, /maxKeys/],
  ];
  test.each(cases)("rejects %s", (_, options, message) => {
    let caught: unknown;
    try {
      createRateLimiter(options as Parameters<typeof createRateLimiter>[0]);
    } catch (error) {
      caught = error;
    }
    expect(isGroundworkError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(message);
  });

  test("the types require db and table together, or a store", () => {
    // @ts-expect-error table is missing
    const a = () => createRateLimiter({ secret: TEST_SECRET, db: { execute: async () => [] } });
    const b = () =>
      // @ts-expect-error a store excludes db
      createRateLimiter({ secret: TEST_SECRET, store, db: { execute: async () => [] } });
    expect([a, b]).toHaveLength(2);
  });
});

describe("a secret function", () => {
  test("cleanup never calls it", async () => {
    const limiter = createRateLimiter({
      store: memoryStore(),
      secret: () => {
        throw new Error("GROUNDWORK_SECRET is not set");
      },
    });
    expect(await limiter.cleanup()).toBe(0);
    const rule = limiter.rule({ name: "r", limit: 1, window: "1m" });
    await expect(rule.check("x")).rejects.toThrow(/GROUNDWORK_SECRET is not set/);
  });

  test("stores the same keys as the secret itself", async () => {
    const store = memoryStore();
    const options = { name: "r", limit: 2, window: "1m" } as const;
    const plain = createRateLimiter({ store, secret: TEST_SECRET }).rule(options);
    const lazy = createRateLimiter({ store, secret: () => TEST_SECRET }).rule(options);
    expect((await plain.check("x")).remaining).toBe(1);
    expect((await lazy.check("x")).remaining).toBe(0);
  });
});
