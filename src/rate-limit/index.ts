/**
 * `@vantedev/groundwork/rate-limit`: fixed-window and token-bucket rate limiting in Postgres, with an
 * in-memory fallback and an optional Redis store.
 *
 * ```ts
 * import { createRateLimiter } from "@vantedev/groundwork/rate-limit";
 *
 * const limiter = createRateLimiter({ db, table: rateLimits, secret: env.GROUNDWORK_SECRET });
 * export const loginLimit = limiter.rule({ name: "login:ip", limit: 5, window: "15m" });
 * export const apiLimit = limiter.rule({ name: "api", algorithm: "token-bucket", rate: 10, per: "1s", burst: 120 });
 * ```
 *
 * @module @vantedev/groundwork/rate-limit
 */
export { type IpSubjectOptions, ipSubject } from "./ip-subject.ts";
export { createRateLimiter, type RateLimiterOptions } from "./limiter.ts";
export { type MemoryStore, type MemoryStoreOptions, memoryStore } from "./memory-store.ts";
export { type RedisEvalClient, type RedisStoreOptions, redisStore } from "./redis-store.ts";
export type {
  CheckOptions,
  ConsumeInput,
  FixedWindowRuleOptions,
  OnError,
  Policy,
  RateLimitAlgorithm,
  RateLimiter,
  RateLimitResult,
  RateLimitRule,
  RateLimitStore,
  ResetOptions,
  RuleOptions,
  StoreState,
  TokenBucketRuleOptions,
} from "./types.ts";
