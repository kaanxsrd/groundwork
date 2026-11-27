import type { GroundworkDatabase } from "../internal/db.ts";
import type { Duration } from "../internal/duration.ts";

/**
 * What a rule does when its store (Postgres or Redis) fails or times out:
 *
 * - `"memory"`: count in this process's memory until the store is back. Limits hold per instance.
 * - `"allow"`: let every request through (fail open).
 * - `"deny"`: reject every request (fail closed).
 */
export type OnError = "memory" | "allow" | "deny";

export type RateLimitAlgorithm = "fixed-window" | "token-bucket";

interface RuleOptionsBase {
  /**
   * Identifies the rule, for example `"login:ip"`. It is part of every stored key and is sent in
   * the `RateLimit-Policy` header, so it may use letters, digits and `_ . : / -` only.
   */
  readonly name: string;
  /** Overrides the limiter's `onError` for this rule. */
  readonly onError?: OnError | undefined;
}

/** At most `limit` cost per `window`. The window starts at a subject's first request. */
export interface FixedWindowRuleOptions extends RuleOptionsBase {
  readonly algorithm?: "fixed-window" | undefined;
  /** Cost allowed per window. A positive integer. */
  readonly limit: number;
  readonly window: Duration;
  readonly rate?: never;
  readonly per?: never;
  readonly burst?: never;
}

/**
 * A bucket of `burst` tokens that refills at `rate` tokens per `per`. Allows short bursts while
 * holding the long-run rate.
 */
export interface TokenBucketRuleOptions extends RuleOptionsBase {
  readonly algorithm: "token-bucket";
  /** Tokens added per `per`. A positive integer. */
  readonly rate: number;
  readonly per: Duration;
  /** Bucket size: the most cost allowed at once. A positive integer. Defaults to `rate`. */
  readonly burst?: number | undefined;
  readonly limit?: never;
  readonly window?: never;
}

export type RuleOptions = FixedWindowRuleOptions | TokenBucketRuleOptions;

export interface CheckOptions {
  /**
   * How much this request uses, for example the number of events in a batch. Defaults to 1.
   * `0` reads the current state without using anything. A request whose cost does not fit is
   * rejected without using anything, so one oversized request never burns the rest of a window.
   */
  readonly cost?: number | undefined;
}

export interface ResetOptions {
  /** Run the reset inside this transaction (Postgres store only). */
  readonly tx?: GroundworkDatabase | undefined;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** The window's limit, or the bucket's burst size. */
  readonly limit: number;
  /** Cost still available right now, after this request. */
  readonly remaining: number;
  /** When the window ends, or when the bucket will be full again. */
  readonly resetAt: Date;
  /** How long to wait before this request would be allowed. 0 when allowed. */
  readonly retryAfterMs: number;
  /**
   * `RateLimit-Policy` and `RateLimit` (draft-ietf-httpapi-ratelimit-headers-11), plus
   * `Retry-After` when denied. Pass straight to a `Response`.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** `false` normally. When the store failed, the `onError` mode that produced this result. */
  readonly degraded: false | OnError;
}

export interface RateLimitRule {
  readonly name: string;
  readonly algorithm: RateLimitAlgorithm;
  /** Uses `cost` (default 1) for `subject`, an IP address, user id or API key id. One round trip. */
  check(subject: string, options?: CheckOptions): Promise<RateLimitResult>;
  /** Forgets `subject`'s usage, for example after a successful login. */
  reset(subject: string, options?: ResetOptions): Promise<void>;
}

export interface RateLimiter {
  /**
   * Defines a rule. It does no I/O, so a rule can be defined per request when its limit varies.
   * Rules with the same algorithm and name share counters.
   */
  rule(options: RuleOptions): RateLimitRule;
  /** Deletes expired rows. Run it every hour or so; returns how many rows it deleted. */
  cleanup(): Promise<number>;
}

/** A rule in normalised form, as stores see it. Internal. */
export type Policy =
  | { readonly algorithm: "fixed-window"; readonly limit: number; readonly windowMs: number }
  | {
      readonly algorithm: "token-bucket";
      readonly burst: number;
      readonly rate: number;
      readonly perMs: number;
      /** Tokens added per millisecond. */
      readonly ratePerMs: number;
    };

/** Internal. */
export interface ConsumeInput {
  /** HMAC of the algorithm, rule name and subject. Never the raw subject. */
  readonly key: string;
  readonly rule: string;
  readonly cost: number;
  readonly policy: Policy;
  /** Epoch milliseconds from the injected clock, or `null` to use the store's own time. */
  readonly now: number | null;
}

/** What a store reports after `consume`. Times are epoch milliseconds. Internal. */
export interface StoreState {
  readonly allowed: boolean;
  /** The time the store used for this decision. */
  readonly now: number;
  /** The stored row, after the update when allowed, or `null` if there is none. */
  readonly row: {
    readonly used: number;
    readonly updatedAt: number;
    readonly expiresAt: number;
  } | null;
}

/**
 * How a store works inside groundwork: the Postgres store (the default), `redisStore()` and
 * `memoryStore()`. Internal, so it can change in a minor release, when a new algorithm needs
 * more from stores, say.
 */
export interface Store {
  readonly kind: string;
  /** Atomically uses `cost` if it fits, and never uses anything when it doesn't. `0` writes nothing. */
  consume(input: ConsumeInput): Promise<StoreState>;
  reset(key: string, options?: ResetOptions): Promise<void>;
  /** Deletes rows that expired before `now` (or the store's own time). */
  cleanup(now: number | null): Promise<number>;
}

declare const OPAQUE: unique symbol;

/**
 * Where a limiter keeps its counters instead of Postgres: `redisStore()`, or `memoryStore()` for
 * tests and single-instance apps. Its members are internal, so a store can only come from
 * groundwork, and how stores work can change without a breaking release.
 */
export interface RateLimitStore {
  readonly [OPAQUE]: true;
}

/** The store behind a `RateLimitStore`. Internal. */
export const storeOf = (store: RateLimitStore): Store => store as unknown as Store;

/** A store as the opaque public type. Internal. */
export const opaque = <T extends Store>(store: T): RateLimitStore & Omit<T, keyof Store> =>
  store as unknown as RateLimitStore & Omit<T, keyof Store>;
