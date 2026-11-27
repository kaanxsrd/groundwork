import { type Clock, systemClock } from "../internal/clock.ts";
import { lazySubkey, type SecretSource } from "../internal/crypto.ts";
import type { GroundworkDatabase } from "../internal/db.ts";
import { type Duration, MAX_TIMER_MS, parseDuration } from "../internal/duration.ts";
import { GroundworkError } from "../internal/errors.ts";
import { consoleLogger, createOnceLogger, type Logger } from "../internal/logger.ts";
import type { RateLimitsTable } from "../schema/rate-limits.ts";
import { memoryStoreImplementation } from "./memory-store.ts";
import {
  capacityOf,
  type NormalizedRule,
  normalizeRule,
  resultFor,
  storageKey,
  validateCost,
  validateOnError,
  validateSubject,
} from "./policy.ts";
import { postgresStore } from "./postgres-store.ts";
import {
  type CheckOptions,
  type OnError,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
  type RateLimitStore,
  type ResetOptions,
  type RuleOptions,
  type Store,
  type StoreState,
  storeOf,
} from "./types.ts";

/** After the store fails, skip it for this long before trying again. */
export const STORE_RETRY_MS = 5_000;

const OUTAGE_LOG_KEY = "store-down";

interface CommonOptions {
  /**
   * The app secret, or a function that returns it on first use. Subjects are stored as HMACs keyed
   * by a subkey derived from it. `cleanup()` never needs it.
   */
  readonly secret: SecretSource;
  /** What rules do when the store fails or times out. Defaults to `"memory"`. */
  readonly onError?: OnError | undefined;
  /**
   * Give up on the store after this long and use `onError` instead. Defaults to `"1s"`.
   * `false` waits as long as the driver does.
   */
  readonly timeout?: Duration | false | undefined;
  /** Options for the in-memory fallback. */
  readonly memory?: { readonly maxKeys?: number | undefined } | undefined;
  /**
   * Time source. By default each store uses its own clock (Postgres or Redis server time), so app
   * instances with skewed clocks still agree. Inject one in tests.
   */
  readonly clock?: Clock | undefined;
  /** Defaults to `console` (warnings and errors only). */
  readonly logger?: Logger | undefined;
}

export type RateLimiterOptions = CommonOptions &
  (
    | {
        /** Your Drizzle database. Counters go in `table`. */
        readonly db: GroundworkDatabase;
        /** The `rateLimits` table from `groundworkTables()`. */
        readonly table: RateLimitsTable;
        readonly store?: undefined;
      }
    | {
        /** Another store, such as `redisStore()`, instead of Postgres. */
        readonly store: RateLimitStore;
        readonly db?: undefined;
        readonly table?: undefined;
      }
  );

function errorSummary(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) };
  }
  return { message: String(error) };
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number | null): Promise<T> {
  if (timeoutMs === null) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Rate-limit store did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates a rate limiter. Define rules on it once, at module scope:
 *
 * ```ts
 * const limiter = createRateLimiter({ db, table: rateLimits, secret: env.GROUNDWORK_SECRET });
 * export const loginLimit = limiter.rule({ name: "login:ip", limit: 5, window: "15m" });
 *
 * const result = await loginLimit.check(ip);
 * if (!result.allowed) return new Response("Too many attempts", { status: 429, headers: result.headers });
 * ```
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "createRateLimiter needs an options object.");
  }
  const subkey = lazySubkey(options.secret, "rate-limit");
  const defaultOnError = validateOnError(options.onError, "onError") ?? "memory";
  const timeoutMs =
    options.timeout === false
      ? null
      : parseDuration(options.timeout ?? "1s", { label: "timeout", minMs: 1, maxMs: MAX_TIMER_MS });
  const clock = options.clock;
  const fallbackClock = clock ?? systemClock;
  const logger = options.logger ?? consoleLogger;
  const once = createOnceLogger(logger);

  let store: Store;
  if (options.store !== undefined) {
    if (options.db !== undefined || options.table !== undefined) {
      throw new GroundworkError("invalid_config", "Pass either store, or db and table, not both.");
    }
    store = storeOf(options.store);
  } else {
    if (options.db === undefined || options.table === undefined) {
      throw new GroundworkError(
        "invalid_config",
        "createRateLimiter needs db and table (the rateLimits table from groundworkTables()), or a store.",
      );
    }
    store = postgresStore({ db: options.db, table: options.table });
  }
  const memory = memoryStoreImplementation({
    maxKeys: options.memory?.maxKeys,
    clock: fallbackClock,
  });

  // Circuit breaker: while the store is known to be down, don't wait on it for every request.
  let storeDownUntil = 0;
  let storeDown = false;

  function markDown(error: unknown, mode: OnError): void {
    storeDown = true;
    storeDownUntil = fallbackClock.now().getTime() + STORE_RETRY_MS;
    once.once(
      "error",
      OUTAGE_LOG_KEY,
      `Rate-limit store (${store.kind}) failed; rules fall back to their onError mode until it answers again.`,
      { store: store.kind, onError: mode, error: errorSummary(error) },
    );
  }

  function markUp(): void {
    if (!storeDown) return;
    storeDown = false;
    once.reset(OUTAGE_LOG_KEY);
    (logger.info ?? logger.warn).call(
      logger,
      `Rate-limit store (${store.kind}) is answering again.`,
      {
        store: store.kind,
      },
    );
  }

  async function degraded(
    rule: NormalizedRule,
    key: string,
    cost: number,
    now: number | null,
    mode: OnError,
  ): Promise<RateLimitResult> {
    if (mode === "memory") {
      const state = await memory.consume({ key, rule: rule.name, cost, policy: rule.policy, now });
      return resultFor(rule, state, cost, "memory");
    }
    const at = now ?? fallbackClock.now().getTime();
    if (mode === "allow") {
      const { policy } = rule;
      const used = Math.min(cost, capacityOf(policy));
      const expiresAt =
        policy.algorithm === "fixed-window" ? at + policy.windowMs : at + used / policy.ratePerMs;
      const state: StoreState = { allowed: true, now: at, row: { used, updatedAt: at, expiresAt } };
      return resultFor(rule, state, cost, "allow");
    }
    const retryMs = Math.max(1_000, storeDownUntil - fallbackClock.now().getTime());
    return resultFor(rule, { allowed: false, now: at, row: null }, cost, "deny", retryMs);
  }

  function defineRule(ruleOptions: RuleOptions): RateLimitRule {
    const rule = normalizeRule(ruleOptions);
    const mode = rule.onError ?? defaultOnError;

    return {
      name: rule.name,
      algorithm: rule.algorithm,
      async check(subject: string, checkOptions?: CheckOptions): Promise<RateLimitResult> {
        const key = storageKey(subkey(), rule.algorithm, rule.name, validateSubject(subject));
        const cost = validateCost(checkOptions?.cost ?? 1);
        const now = clock ? clock.now().getTime() : null;

        if (storeDown && fallbackClock.now().getTime() < storeDownUntil) {
          return degraded(rule, key, cost, now, mode);
        }
        let state: StoreState;
        try {
          state = await withTimeout(
            store.consume({ key, rule: rule.name, cost, policy: rule.policy, now }),
            timeoutMs,
          );
        } catch (error) {
          markDown(error, mode);
          return degraded(rule, key, cost, now, mode);
        }
        markUp();
        return resultFor(rule, state, cost);
      },
      async reset(subject: string, resetOptions?: ResetOptions): Promise<void> {
        const key = storageKey(subkey(), rule.algorithm, rule.name, validateSubject(subject));
        if (resetOptions?.tx !== undefined && store.kind !== "postgres") {
          throw new GroundworkError(
            "invalid_argument",
            `reset({ tx }) needs the Postgres store; this limiter uses ${store.kind}.`,
          );
        }
        await memory.reset(key);
        await store.reset(key, resetOptions);
      },
    };
  }

  return {
    rule: defineRule,
    async cleanup() {
      const now = clock ? clock.now().getTime() : null;
      await memory.cleanup(now);
      return store.cleanup(now);
    },
  };
}
