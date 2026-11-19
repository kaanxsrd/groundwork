import { hmacSha256Parts } from "../internal/crypto.ts";
import { parseDuration } from "../internal/duration.ts";
import { GroundworkError } from "../internal/errors.ts";
import type {
  FixedWindowRuleOptions,
  OnError,
  Policy,
  RateLimitAlgorithm,
  RateLimitResult,
  RuleOptions,
  StoreState,
  TokenBucketRuleOptions,
} from "./types.ts";

/** Slack for floating-point error in token arithmetic. Shared by every store. */
export const EPSILON = 1e-9;

// Header-safe: a structured-field String may only hold printable ASCII, and the name is also used
// in logs and as a Redis key component.
const RULE_NAME_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;

const ON_ERROR_MODES: readonly OnError[] = ["memory", "allow", "deny"];

export interface NormalizedRule {
  readonly name: string;
  readonly algorithm: RateLimitAlgorithm;
  readonly policy: Policy;
  readonly onError: OnError | undefined;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new GroundworkError(
      "invalid_config",
      `Invalid ${label} ${JSON.stringify(value)}: it must be a positive integer.`,
    );
  }
  return value;
}

export function validateOnError(value: unknown, label: string): OnError | undefined {
  if (value === undefined) return undefined;
  if (!ON_ERROR_MODES.includes(value as OnError)) {
    throw new GroundworkError(
      "invalid_config",
      `Invalid ${label} ${JSON.stringify(value)}: use "memory", "allow" or "deny".`,
    );
  }
  return value as OnError;
}

/** Validates rule options once, when the rule is defined, so `check` never has to. */
export function normalizeRule(options: RuleOptions): NormalizedRule {
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "Rate-limit rule options must be an object.");
  }
  const { name } = options;
  if (typeof name !== "string" || !RULE_NAME_PATTERN.test(name)) {
    throw new GroundworkError(
      "invalid_config",
      `Invalid rule name ${JSON.stringify(name)}: use 1 to 128 letters, digits or _ . : / - (for example "login:ip").`,
    );
  }
  const onError = validateOnError(options.onError, `onError for rule "${name}"`);
  const algorithm = options.algorithm ?? "fixed-window";

  if (algorithm === "fixed-window") {
    const fixed = options as FixedWindowRuleOptions;
    return {
      name,
      algorithm,
      onError,
      policy: {
        algorithm,
        limit: positiveInteger(fixed.limit, `limit for rule "${name}"`),
        windowMs: parseDuration(fixed.window, { label: `window for rule "${name}"`, minMs: 1 }),
      },
    };
  }
  if (algorithm === "token-bucket") {
    const bucket = options as TokenBucketRuleOptions;
    const rate = positiveInteger(bucket.rate, `rate for rule "${name}"`);
    const perMs = parseDuration(bucket.per, { label: `per for rule "${name}"`, minMs: 1 });
    const burst =
      bucket.burst === undefined ? rate : positiveInteger(bucket.burst, `burst for rule "${name}"`);
    return {
      name,
      algorithm,
      onError,
      policy: { algorithm, rate, perMs, burst, ratePerMs: rate / perMs },
    };
  }
  throw new GroundworkError(
    "invalid_config",
    `Invalid algorithm ${JSON.stringify(algorithm)} for rule "${name}": use "fixed-window" or "token-bucket".`,
  );
}

export function validateCost(cost: unknown): number {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new GroundworkError(
      "invalid_argument",
      `Invalid cost ${JSON.stringify(cost)}: it must be a finite number of 0 or more.`,
    );
  }
  return cost;
}

export function validateSubject(subject: unknown): string {
  if (typeof subject !== "string") {
    throw new GroundworkError("invalid_argument", "The rate-limit subject must be a string.");
  }
  return subject;
}

/**
 * The stored key: HMAC over the algorithm, rule name and subject, so raw subjects (IP addresses,
 * user ids) never reach the store. The "rl1" tag versions the format.
 */
export function storageKey(
  subkey: Uint8Array,
  algorithm: RateLimitAlgorithm,
  rule: string,
  subject: string,
): string {
  return hmacSha256Parts(subkey, ["rl1", algorithm, rule, subject]).toString("base64url");
}

/** Capacity of the rule: the window's limit or the bucket's size. */
export function capacityOf(policy: Policy): number {
  return policy.algorithm === "fixed-window" ? policy.limit : policy.burst;
}

/** How much is in use at `now`, given the stored row. */
export function levelAt(policy: Policy, state: StoreState): number {
  const { row, now } = state;
  if (!row) return 0;
  if (policy.algorithm === "fixed-window") return row.expiresAt > now ? row.used : 0;
  const refilled = Math.max(0, now - row.updatedAt) * policy.ratePerMs;
  return Math.max(0, row.used - refilled);
}

/**
 * Rounds a duration up to whole milliseconds, ignoring floating-point noise: refilling 99ms at
 * 0.01 tokens/ms leaves a 1.0000000000000016ms wait, which is 1ms, not 2.
 */
function ceilMs(value: number): number {
  return Math.ceil(value - 1e-6);
}

/** Whether `cost` fits on top of `level`. Every store uses this exact comparison. */
export function fits(level: number, cost: number, capacity: number): boolean {
  return level + cost <= capacity + EPSILON;
}

function headersFor(
  name: string,
  policy: Policy,
  remaining: number,
  resetInSeconds: number,
  retryAfterMs: number,
  allowed: boolean,
): Record<string, string> {
  let quota: number;
  let windowSeconds: number;
  if (policy.algorithm === "fixed-window") {
    quota = policy.limit;
    windowSeconds = Math.max(1, Math.ceil(policy.windowMs / 1000));
  } else {
    // The sustained rate, rescaled to a whole number of seconds as the draft requires.
    windowSeconds = Math.max(1, Math.ceil(policy.perMs / 1000));
    quota = Math.max(1, Math.floor((policy.rate * windowSeconds * 1000) / policy.perMs));
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const headers: Record<string, string> = {
    "RateLimit-Policy": `"${name}";q=${quota};w=${windowSeconds}`,
    // When denied, the effective window ends when the client may retry (draft-11 section 6).
    RateLimit: `"${name}";r=${remaining};t=${allowed ? resetInSeconds : retryAfterSeconds}`,
  };
  if (!allowed) headers["Retry-After"] = String(retryAfterSeconds);
  return headers;
}

/**
 * Turns what a store reported into the public result. Shared by every store.
 * `retryAfterOverrideMs` replaces the computed wait on a denial (used by `onError: "deny"`).
 */
export function resultFor(
  rule: NormalizedRule,
  state: StoreState,
  cost: number,
  degraded: false | OnError = false,
  retryAfterOverrideMs?: number,
): RateLimitResult {
  const { policy } = rule;
  const { now, allowed } = state;
  const capacity = capacityOf(policy);
  const level = levelAt(policy, state);

  let remaining = Math.max(0, Math.floor(capacity - level + EPSILON));
  let resetAt: number;
  let retryAfterMs = 0;

  if (policy.algorithm === "fixed-window") {
    const active = state.row !== null && state.row.expiresAt > now;
    resetAt = active && state.row ? state.row.expiresAt : now + policy.windowMs;
    if (!allowed) retryAfterMs = resetAt - now;
  } else {
    resetAt = now + ceilMs(level / policy.ratePerMs);
    if (!allowed) {
      retryAfterMs =
        cost > capacity + EPSILON
          ? // Never fits. Say "at least a full refill" rather than suggesting it soon will.
            Math.max(resetAt - now, ceilMs(capacity / policy.ratePerMs))
          : ceilMs((level + cost - capacity) / policy.ratePerMs);
    }
  }

  if (!allowed) {
    if (retryAfterOverrideMs !== undefined) retryAfterMs = retryAfterOverrideMs;
    retryAfterMs = Math.max(1, ceilMs(retryAfterMs));
    // A denial means less than `cost` was left, even if the row we read back was a moment stale.
    remaining = Math.min(remaining, Math.max(0, Math.ceil(cost) - 1));
  }

  const resetInSeconds = Math.max(0, Math.ceil((resetAt - now) / 1000));
  return {
    allowed,
    limit: capacity,
    remaining,
    resetAt: new Date(resetAt),
    retryAfterMs,
    headers: headersFor(rule.name, policy, remaining, resetInSeconds, retryAfterMs, allowed),
    degraded,
  };
}
