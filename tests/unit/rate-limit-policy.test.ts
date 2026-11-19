import { describe, expect, test } from "bun:test";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import type { Duration } from "../../src/internal/duration.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";
import {
  normalizeRule,
  resultFor,
  storageKey,
  validateCost,
  validateSubject,
} from "../../src/rate-limit/policy.ts";
import type { RuleOptions } from "../../src/rate-limit/types.ts";
import { TEST_SECRET } from "../support/rate-limit-conformance.ts";

function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (isGroundworkError(error)) return `${error.code}: ${error.message}`;
    throw error;
  }
  throw new Error("expected a GroundworkError");
}

describe("normalizeRule", () => {
  test("defaults to a fixed window", () => {
    expect(normalizeRule({ name: "login:ip", limit: 5, window: "15m" })).toEqual({
      name: "login:ip",
      algorithm: "fixed-window",
      onError: undefined,
      policy: { algorithm: "fixed-window", limit: 5, windowMs: 900_000 },
    });
  });

  test("token bucket burst defaults to the rate", () => {
    const rule = normalizeRule({ name: "api", algorithm: "token-bucket", rate: 10, per: "1s" });
    expect(rule.policy).toEqual({
      algorithm: "token-bucket",
      rate: 10,
      perMs: 1_000,
      burst: 10,
      ratePerMs: 0.01,
    });
  });

  test.each([
    ["", "Invalid rule name"],
    ["has space", "Invalid rule name"],
    ['quo"te', "Invalid rule name"],
    ["ünïcode", "Invalid rule name"],
    ["x".repeat(129), "Invalid rule name"],
  ])("rejects the name %p", (name, message) => {
    expect(configError(() => normalizeRule({ name, limit: 1, window: "1m" }))).toContain(message);
  });

  test("accepts every allowed name character", () => {
    expect(() => normalizeRule({ name: "a-Z_0.9:/x", limit: 1, window: "1m" })).not.toThrow();
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5"])(
    "rejects the limit %p",
    (limit) => {
      expect(
        configError(() => normalizeRule({ name: "r", limit: limit as number, window: "1m" })),
      ).toMatch(/^invalid_config: Invalid limit for rule "r"/);
    },
  );

  test("rejects bad windows, rates, pers, bursts, algorithms and onError modes", () => {
    expect(configError(() => normalizeRule({ name: "r", limit: 1, window: "0s" }))).toContain(
      'Invalid window for rule "r"',
    );
    expect(
      configError(() => normalizeRule({ name: "r", limit: 1, window: "15" as Duration })),
    ).toContain("Invalid window");
    expect(
      configError(() =>
        normalizeRule({ name: "r", algorithm: "token-bucket", rate: 0, per: "1s" }),
      ),
    ).toContain("Invalid rate");
    expect(
      configError(() =>
        normalizeRule({ name: "r", algorithm: "token-bucket", rate: 1, per: "0ms" }),
      ),
    ).toContain("Invalid per");
    expect(
      configError(() =>
        normalizeRule({ name: "r", algorithm: "token-bucket", rate: 1, per: "1s", burst: 0 }),
      ),
    ).toContain("Invalid burst");
    expect(
      configError(() =>
        normalizeRule({
          name: "r",
          algorithm: "sliding-window",
          limit: 1,
          window: "1m",
        } as unknown as RuleOptions),
      ),
    ).toContain('Invalid algorithm "sliding-window"');
    expect(
      configError(() =>
        normalizeRule({
          name: "r",
          limit: 1,
          window: "1m",
          onError: "retry",
        } as unknown as RuleOptions),
      ),
    ).toContain('use "memory", "allow" or "deny"');
    expect(configError(() => normalizeRule(null as unknown as RuleOptions))).toContain(
      "must be an object",
    );
  });

  test("the option types reject mixed-up algorithms at compile time", () => {
    // @ts-expect-error a fixed window has no rate
    const a: RuleOptions = { name: "r", limit: 1, window: "1m", rate: 5 };
    // @ts-expect-error a token bucket needs rate and per, not limit and window
    const b: RuleOptions = { name: "r", algorithm: "token-bucket", limit: 1, window: "1m" };
    // @ts-expect-error durations need a unit
    const c: RuleOptions = { name: "r", limit: 1, window: 60 };
    expect([a, b, c]).toHaveLength(3);
  });
});

describe("check arguments", () => {
  test("cost must be a finite number of 0 or more", () => {
    expect(validateCost(0)).toBe(0);
    expect(validateCost(2.5)).toBe(2.5);
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) {
      expect(configError(() => validateCost(cost))).toMatch(/^invalid_argument: Invalid cost/);
    }
  });

  test("the subject must be a string", () => {
    expect(validateSubject("")).toBe("");
    expect(configError(() => validateSubject(42))).toMatch(/^invalid_argument/);
    expect(configError(() => validateSubject(undefined))).toMatch(/^invalid_argument/);
  });
});

describe("storageKey", () => {
  const subkey = deriveSubkey(TEST_SECRET, "rate-limit");

  test("never changes (it is part of the storage format)", () => {
    // If this fails, every stored counter would silently reset on upgrade.
    expect(storageKey(subkey, "fixed-window", "login:ip", "203.0.113.7")).toBe(
      "V9xH2QRLtxcgtadq5KxrQSeL45kYe2goA_IpxInFhrs",
    );
    expect(storageKey(subkey, "token-bucket", "api", "key_123")).toBe(
      "aJbbsJKqayY9seaZ6amfjGCWwRNK0u2_YPN9Tcmxr1Q",
    );
  });

  test("depends on the algorithm, rule, subject and secret, and hides the subject", () => {
    const base = storageKey(subkey, "fixed-window", "a", "b");
    expect(storageKey(subkey, "token-bucket", "a", "b")).not.toBe(base);
    expect(storageKey(subkey, "fixed-window", "ab", "")).not.toBe(
      storageKey(subkey, "fixed-window", "a", "b"),
    );
    expect(
      storageKey(deriveSubkey(`${TEST_SECRET}x`, "rate-limit"), "fixed-window", "a", "b"),
    ).not.toBe(base);
    expect(base).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("resultFor", () => {
  const fixed = normalizeRule({ name: "f", limit: 10, window: "1m" });
  const bucket = normalizeRule({ name: "b", algorithm: "token-bucket", rate: 5, per: "500ms" });

  test("headers express a sub-second bucket as a whole-second policy", () => {
    const result = resultFor(
      bucket,
      { allowed: true, now: 0, row: { used: 1, updatedAt: 0, expiresAt: 100 } },
      1,
    );
    // 5 per 500ms is 10 per second.
    expect(result.headers["RateLimit-Policy"]).toBe('"b";q=10;w=1');
  });

  test.each([
    [{ rate: 100, per: "1m" as Duration }, '"x";q=100;w=60'],
    [{ rate: 1, per: "90s" as Duration }, '"x";q=1;w=90'],
    [{ rate: 3, per: "1500ms" as Duration }, '"x";q=4;w=2'],
  ])("token bucket %p → %s", (options, expected) => {
    const rule = normalizeRule({ name: "x", algorithm: "token-bucket", ...options });
    expect(
      resultFor(rule, { allowed: true, now: 0, row: null }, 0).headers["RateLimit-Policy"],
    ).toBe(expected);
  });

  test("a denial computed from a stale row still reports less than the cost as remaining", () => {
    // The row read back says 2 used of 10, but the store denied a cost of 4: someone else got there first.
    const result = resultFor(
      fixed,
      { allowed: false, now: 0, row: { used: 2, updatedAt: 0, expiresAt: 30_000 } },
      4,
    );
    expect(result.remaining).toBe(3);
    expect(result.retryAfterMs).toBe(30_000);
    expect(result.headers["Retry-After"]).toBe("30");
  });

  test("never asks a client to retry in 0ms", () => {
    const result = resultFor(
      bucket,
      { allowed: false, now: 1_000, row: { used: 0, updatedAt: 0, expiresAt: 0 } },
      1,
    );
    expect(result.retryAfterMs).toBe(1);
    expect(result.headers["Retry-After"]).toBe("1");
  });
});
