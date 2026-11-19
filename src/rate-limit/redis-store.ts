import { toNumber } from "../internal/db.ts";
import { GroundworkError } from "../internal/errors.ts";
import { capacityOf, EPSILON } from "./policy.ts";
import type { ConsumeInput, RateLimitStore, StoreState } from "./types.ts";

/**
 * The one Redis capability the store needs: running a Lua script. Adapt your client in one line:
 *
 * ```ts
 * // ioredis
 * const client = { eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) };
 * // node-redis
 * const client = { eval: (script, keys, args) => redis.eval(script, { keys, arguments: args }) };
 * ```
 */
export interface RedisEvalClient {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export interface RedisStoreOptions {
  readonly client: RedisEvalClient;
  /** Prepended to every Redis key. Defaults to `"gw:rl:"`. */
  readonly prefix?: string | undefined;
}

// Same semantics as the Postgres store and memory store: a cost that doesn't fit uses nothing.
// Replies are strings, because Redis truncates Lua numbers to integers.
const CONSUME_SCRIPT = `
local now
if ARGV[5] == "" then
  local t = redis.call("TIME")
  now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
else
  now = tonumber(ARGV[5])
end
local fixed = ARGV[1] == "fixed-window"
local cost = tonumber(ARGV[2])
local capacity = tonumber(ARGV[3])
local param = tonumber(ARGV[4])
local epsilon = tonumber(ARGV[6])
local stored = redis.call("HMGET", KEYS[1], "used", "updated", "expires")
local used = tonumber(stored[1])
local updated = tonumber(stored[2])
local expires = tonumber(stored[3])
local level = 0
local active = false
if used then
  if fixed then
    active = expires > now
    if active then level = used end
  else
    level = math.max(0, used - math.max(0, now - updated) * param)
  end
end
if level + cost > capacity + epsilon then
  if used then
    return {"0", tostring(now), tostring(used), tostring(updated), tostring(expires)}
  end
  return {"0", tostring(now)}
end
local newUsed = level + cost
local newExpires
if fixed then
  if active then newExpires = expires else newExpires = now + param end
else
  newExpires = now + newUsed / param
end
redis.call("HSET", KEYS[1], "used", tostring(newUsed), "updated", tostring(now), "expires", tostring(newExpires))
-- Relative, with a second of slack: an injected clock may be far from the server's.
redis.call("PEXPIRE", KEYS[1], math.max(1, math.ceil(newExpires - now)) + 1000)
return {"1", tostring(now), tostring(newUsed), tostring(now), tostring(newExpires)}
`;

const RESET_SCRIPT = `return redis.call("DEL", KEYS[1])`;

function parseReply(reply: unknown): StoreState {
  if (!Array.isArray(reply) || reply.length < 2) {
    throw new Error("Unexpected reply from the rate-limit Redis script.");
  }
  const [allowed, now, used, updated, expires] = reply as unknown[];
  return {
    allowed: String(allowed) === "1",
    now: toNumber(now),
    row:
      used === undefined
        ? null
        : { used: toNumber(used), updatedAt: toNumber(updated), expiresAt: toNumber(expires) },
  };
}

/** Counters in Redis, for apps that already run it. Postgres stays the default. */
export function redisStore(options: RedisStoreOptions): RateLimitStore & { kind: "redis" } {
  const { client } = options;
  if (!client || typeof client.eval !== "function") {
    throw new GroundworkError(
      "invalid_config",
      "redisStore needs a client with eval(script, keys, args). See the RedisEvalClient docs for one-line adapters.",
    );
  }
  const prefix = options.prefix ?? "gw:rl:";
  if (typeof prefix !== "string") {
    throw new GroundworkError("invalid_config", "redisStore prefix must be a string.");
  }

  return {
    kind: "redis",
    async consume(input: ConsumeInput) {
      const { policy } = input;
      const param = policy.algorithm === "fixed-window" ? policy.windowMs : policy.ratePerMs;
      const reply = await client.eval(
        CONSUME_SCRIPT,
        [`${prefix}${input.key}`],
        [
          policy.algorithm,
          String(input.cost),
          String(capacityOf(policy)),
          String(param),
          input.now === null ? "" : String(input.now),
          String(EPSILON),
        ],
      );
      return parseReply(reply);
    },
    async reset(key) {
      await client.eval(RESET_SCRIPT, [`${prefix}${key}`], []);
    },
    // Redis expires keys itself.
    cleanup: async () => 0,
  };
}
