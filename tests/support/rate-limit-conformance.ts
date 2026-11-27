// One behaviour, every store: the memory, Postgres and Redis stores must give identical results
// for the same sequence of checks. Each test file calls rateLimitConformance() with a factory.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { LogContext, Logger } from "../../src/internal/logger.ts";
import type {
  CheckOptions,
  RateLimiter,
  RateLimitResult,
  RateLimitRule,
  RuleOptions,
} from "../../src/rate-limit/index.ts";
import { createTestClock, type TestClock } from "../../src/testing/index.ts";

export const TEST_SECRET = "conformance-test-secret-0123456789abcdef";
export const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** A logger that records everything, so tests can assert nothing went wrong silently. */
export function recordingLogger(): Logger & {
  lines: { level: string; message: string; context?: LogContext }[];
} {
  const lines: { level: string; message: string; context?: LogContext }[] = [];
  const push = (level: string) => (message: string, context?: LogContext) => {
    lines.push(context === undefined ? { level, message } : { level, message, context });
  };
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

export type LimiterFactory = (clock: TestClock, logger: Logger) => RateLimiter;

/** A fresh, unique name or subject, so tests sharing a database never see each other's rows. */
export function unique(label: string): string {
  return `${label}-${randomBytes(4).toString("hex")}`;
}

interface Harness {
  clock: TestClock;
  rule(options: RuleOptions): {
    rule: RateLimitRule;
    check(subject: string, options?: CheckOptions): Promise<RateLimitResult>;
  };
  logger: ReturnType<typeof recordingLogger>;
}

function setup(makeLimiter: LimiterFactory): Harness {
  const clock = createTestClock(T0);
  const logger = recordingLogger();
  const limiter = makeLimiter(clock, logger);
  return {
    clock,
    logger,
    rule(options) {
      const rule = limiter.rule(options);
      return {
        rule,
        async check(subject, checkOptions) {
          const result = await rule.check(subject, checkOptions);
          // A degraded result would mean the store failed and memory answered instead.
          expect(result.degraded).toBe(false);
          expect(logger.lines).toEqual([]);
          return result;
        },
      };
    },
  };
}

const at = (ms: number) => new Date(T0 + ms);

export function rateLimitConformance(label: string, makeLimiter: () => LimiterFactory): void {
  describe(`${label}: fixed window`, () => {
    test("allows up to the limit, then denies until the window ends", async () => {
      const h = setup(makeLimiter());
      const name = unique("fw");
      const { check } = h.rule({ name, limit: 3, window: "1m" });
      const subject = unique("ip");

      const first = await check(subject);
      expect(first).toMatchObject({ allowed: true, limit: 3, remaining: 2, retryAfterMs: 0 });
      expect(first.resetAt).toEqual(at(60_000));
      expect(first.headers).toEqual({
        "RateLimit-Policy": `"${name}";q=3;w=60`,
        RateLimit: `"${name}";r=2;t=60`,
      });

      h.clock.advance("10s");
      expect(await check(subject)).toMatchObject({ allowed: true, remaining: 1 });
      expect((await check(subject)).headers.RateLimit).toBe(`"${name}";r=0;t=50`);

      const denied = await check(subject);
      expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 50_000 });
      expect(denied.resetAt).toEqual(at(60_000));
      expect(denied.headers).toEqual({
        "RateLimit-Policy": `"${name}";q=3;w=60`,
        RateLimit: `"${name}";r=0;t=50`,
        "Retry-After": "50",
      });
    });

    test("rolls over exactly at the end of the window", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({ name: unique("fw"), limit: 2, window: "1m" });
      const subject = unique("ip");
      await check(subject);
      await check(subject);

      h.clock.set(T0 + 59_999);
      expect(await check(subject)).toMatchObject({ allowed: false, retryAfterMs: 1 });

      h.clock.set(T0 + 60_000);
      const fresh = await check(subject);
      expect(fresh).toMatchObject({ allowed: true, remaining: 1 });
      expect(fresh.resetAt).toEqual(at(120_000));

      // The new window is anchored at its first request, not at a multiple of the window.
      h.clock.set(T0 + 150_000);
      const later = await check(subject);
      expect(later).toMatchObject({ allowed: true, remaining: 1 });
      expect(later.resetAt).toEqual(at(210_000));
    });

    test("a denied request uses nothing, so a big cost can't burn the rest of the window", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({ name: unique("fw"), limit: 5, window: "1m" });
      const subject = unique("batch");
      expect(await check(subject, { cost: 3 })).toMatchObject({ allowed: true, remaining: 2 });
      expect(await check(subject, { cost: 3 })).toMatchObject({ allowed: false, remaining: 2 });
      expect(await check(subject, { cost: 2 })).toMatchObject({ allowed: true, remaining: 0 });
    });

    test("a cost above the limit is always denied and uses nothing", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({ name: unique("fw"), limit: 5, window: "1m" });
      const subject = unique("batch");
      const huge = await check(subject, { cost: 6 });
      expect(huge).toMatchObject({ allowed: false, remaining: 5 });
      expect(huge.retryAfterMs).toBe(60_000);
      expect(await check(subject, { cost: 5 })).toMatchObject({ allowed: true, remaining: 0 });
    });

    test("cost 0 reads the state without using anything", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({ name: unique("fw"), limit: 2, window: "1m" });
      const subject = unique("ip");
      expect(await check(subject, { cost: 0 })).toMatchObject({ allowed: true, remaining: 2 });
      await check(subject);
      expect(await check(subject, { cost: 0 })).toMatchObject({ allowed: true, remaining: 1 });
      await check(subject);
      expect(await check(subject, { cost: 0 })).toMatchObject({ allowed: true, remaining: 0 });
    });

    test("cost 0 doesn't start a window, or restart an expired one", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({ name: unique("fw"), limit: 2, window: "10s" });
      const subject = unique("ip");
      // Had this peek started a window at 0s, the checks at 9s would use it up, and the window
      // ending at 10s would let the third check in.
      expect(await check(subject, { cost: 0 })).toMatchObject({ allowed: true, remaining: 2 });
      h.clock.set(T0 + 9_000);
      await check(subject);
      await check(subject);
      h.clock.set(T0 + 10_000);
      expect(await check(subject)).toMatchObject({ allowed: false, retryAfterMs: 9_000 });

      // After the window ends, a peek reports a full window without starting one.
      h.clock.set(T0 + 30_000);
      const peek = await check(subject, { cost: 0 });
      expect(peek).toMatchObject({ allowed: true, remaining: 2 });
      expect(peek.resetAt).toEqual(at(40_000));
      h.clock.set(T0 + 35_000);
      expect((await check(subject)).resetAt).toEqual(at(45_000));
    });

    test("reset forgets a subject", async () => {
      const h = setup(makeLimiter());
      const { rule, check } = h.rule({ name: unique("fw"), limit: 1, window: "1h" });
      const subject = unique("user");
      await check(subject);
      expect((await check(subject)).allowed).toBe(false);
      await rule.reset(subject);
      expect(await check(subject)).toMatchObject({ allowed: true, remaining: 0 });
    });
  });

  describe(`${label}: token bucket`, () => {
    test("refills at the configured rate", async () => {
      const h = setup(makeLimiter());
      const name = unique("tb");
      const { check } = h.rule({ name, algorithm: "token-bucket", rate: 10, per: "1s", burst: 20 });
      const subject = unique("key");

      const drained = await check(subject, { cost: 20 });
      expect(drained).toMatchObject({ allowed: true, limit: 20, remaining: 0, retryAfterMs: 0 });
      // 20 tokens at 10 per second: full again after 2 seconds.
      expect(drained.resetAt).toEqual(at(2_000));
      expect(drained.headers).toEqual({
        "RateLimit-Policy": `"${name}";q=10;w=1`,
        RateLimit: `"${name}";r=0;t=2`,
      });

      const denied = await check(subject);
      expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfterMs: 100 });
      expect(denied.headers["Retry-After"]).toBe("1");

      h.clock.advance(99);
      expect(await check(subject)).toMatchObject({ allowed: false, retryAfterMs: 1 });
      h.clock.advance(1);
      expect(await check(subject)).toMatchObject({ allowed: true, remaining: 0 });

      h.clock.advance("1s");
      expect(await check(subject, { cost: 0 })).toMatchObject({ allowed: true, remaining: 10 });

      // Never more than the burst, however long the bucket sits idle.
      h.clock.advance("1h");
      const full = await check(subject, { cost: 0 });
      expect(full).toMatchObject({ allowed: true, remaining: 20 });
      expect(full.resetAt).toEqual(h.clock.now());

      const five = await check(subject, { cost: 5 });
      expect(five).toMatchObject({ allowed: true, remaining: 15 });
      expect(five.resetAt.getTime() - h.clock.now().getTime()).toBe(500);
    });

    test("a denied request takes no tokens", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({
        name: unique("tb"),
        algorithm: "token-bucket",
        rate: 10,
        per: "1s",
        burst: 20,
      });
      const subject = unique("key");
      expect(await check(subject, { cost: 15 })).toMatchObject({ allowed: true, remaining: 5 });
      // 6 doesn't fit; 1 more token arrives in 100ms.
      expect(await check(subject, { cost: 6 })).toMatchObject({
        allowed: false,
        remaining: 5,
        retryAfterMs: 100,
      });
      h.clock.advance(100);
      expect(await check(subject, { cost: 6 })).toMatchObject({ allowed: true, remaining: 0 });
    });

    test("a cost above the burst never fits", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({
        name: unique("tb"),
        algorithm: "token-bucket",
        rate: 10,
        per: "1s",
        burst: 20,
      });
      const subject = unique("key");
      const result = await check(subject, { cost: 21 });
      expect(result).toMatchObject({ allowed: false, remaining: 20 });
      // At least a full refill, never a misleading "retry in 1ms".
      expect(result.retryAfterMs).toBe(2_000);
      expect(await check(subject, { cost: 20 })).toMatchObject({ allowed: true });
    });

    test("burst defaults to the rate", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({
        name: unique("tb"),
        algorithm: "token-bucket",
        rate: 3,
        per: "1m",
      });
      const subject = unique("key");
      expect(await check(subject, { cost: 3 })).toMatchObject({
        allowed: true,
        limit: 3,
        remaining: 0,
      });
      expect(await check(subject)).toMatchObject({ allowed: false, retryAfterMs: 20_000 });
    });

    test("fractional refill rates don't lose tokens to rounding", async () => {
      const h = setup(makeLimiter());
      // One token every 3 seconds: 1/3000 per ms is not exact in binary.
      const { check } = h.rule({
        name: unique("tb"),
        algorithm: "token-bucket",
        rate: 1,
        per: "3s",
        burst: 1,
      });
      const subject = unique("key");
      for (let i = 0; i < 5; i++) {
        expect(await check(subject)).toMatchObject({ allowed: true, remaining: 0 });
        expect(await check(subject)).toMatchObject({ allowed: false, retryAfterMs: 3_000 });
        h.clock.advance("3s");
      }
    });

    test("a clock that moves backwards never adds tokens", async () => {
      const h = setup(makeLimiter());
      const { check } = h.rule({
        name: unique("tb"),
        algorithm: "token-bucket",
        rate: 10,
        per: "1s",
        burst: 10,
      });
      const subject = unique("key");
      h.clock.set(T0 + 10_000);
      await check(subject, { cost: 10 });
      h.clock.set(T0);
      expect(await check(subject)).toMatchObject({ allowed: false, remaining: 0 });
      h.clock.set(T0 + 10_100);
      expect(await check(subject)).toMatchObject({ allowed: true, remaining: 0 });
    });

    test("reset refills the bucket", async () => {
      const h = setup(makeLimiter());
      const { rule, check } = h.rule({
        name: unique("tb"),
        algorithm: "token-bucket",
        rate: 1,
        per: "1h",
        burst: 2,
      });
      const subject = unique("key");
      await check(subject, { cost: 2 });
      await rule.reset(subject);
      expect(await check(subject, { cost: 0 })).toMatchObject({ remaining: 2 });
    });
  });

  describe(`${label}: isolation`, () => {
    test("subjects, rule names and algorithms each get their own counter", async () => {
      const h = setup(makeLimiter());
      const name = unique("shared");
      const fixed = h.rule({ name, limit: 1, window: "1h" });
      const other = h.rule({ name: unique("other"), limit: 1, window: "1h" });
      const bucket = h.rule({ name, algorithm: "token-bucket", rate: 1, per: "1h" });
      const alice = unique("alice");
      const bob = unique("bob");

      expect((await fixed.check(alice)).allowed).toBe(true);
      expect((await fixed.check(alice)).allowed).toBe(false);
      expect((await fixed.check(bob)).allowed).toBe(true);
      expect((await other.check(alice)).allowed).toBe(true);
      expect((await bucket.check(alice)).allowed).toBe(true);
    });
  });
}
