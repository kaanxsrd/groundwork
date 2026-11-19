import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { createClient } from "redis";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import { createRateLimiter, type RedisEvalClient, redisStore } from "../../src/rate-limit/index.ts";
import { storageKey } from "../../src/rate-limit/policy.ts";
import { createTestClock } from "../../src/testing/index.ts";
import {
  rateLimitConformance,
  recordingLogger,
  T0,
  TEST_SECRET,
  unique,
} from "../support/rate-limit-conformance.ts";

const REDIS_URL = process.env.TEST_REDIS_URL || "redis://127.0.0.1:63790";
// Postgres tests get a database per file; Redis tests get a key prefix per file.
const prefix = `gw:test:${randomBytes(4).toString("hex")}:`;
const subkey = deriveSubkey(TEST_SECRET, "rate-limit");

// The one-line adapters from the docs.
const fromIoredis = (redis: Redis): RedisEvalClient => ({
  eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args),
});
type NodeRedis = ReturnType<typeof createClient>;
const fromNodeRedis = (client: NodeRedis): RedisEvalClient => ({
  eval: (script, keys, args) => client.eval(script, { keys, arguments: args }),
});

let ioredis: Redis;
let nodeRedis: NodeRedis;
const extra: Redis[] = [];

beforeAll(async () => {
  ioredis = new Redis(REDIS_URL, { lazyConnect: true });
  await ioredis.connect();
  nodeRedis = createClient({ url: REDIS_URL });
  await nodeRedis.connect();
});

afterAll(async () => {
  const keys = await ioredis.keys(`${prefix}*`);
  if (keys.length > 0) await ioredis.del(...keys);
  await Promise.all([ioredis.quit(), nodeRedis.quit(), ...extra.map((r) => r.quit())]);
});

rateLimitConformance(
  "redis store (ioredis)",
  () => (clock, logger) =>
    createRateLimiter({
      store: redisStore({ client: fromIoredis(ioredis), prefix }),
      secret: TEST_SECRET,
      clock,
      logger,
    }),
);

rateLimitConformance(
  "redis store (node-redis)",
  () => (clock, logger) =>
    createRateLimiter({
      store: redisStore({ client: fromNodeRedis(nodeRedis), prefix }),
      secret: TEST_SECRET,
      clock,
      logger,
    }),
);

describe("redis store", () => {
  for (const algorithm of ["fixed-window", "token-bucket"] as const) {
    test(`100 concurrent checks against a limit of 10 allow exactly 10 (${algorithm})`, async () => {
      const name = unique("race");
      const logger = recordingLogger();
      const rules = Array.from({ length: 4 }, () => {
        const connection = new Redis(REDIS_URL);
        extra.push(connection);
        return createRateLimiter({
          store: redisStore({ client: fromIoredis(connection), prefix }),
          secret: TEST_SECRET,
          logger,
        }).rule(
          algorithm === "fixed-window"
            ? { name, limit: 10, window: "1h" }
            : { name, algorithm, rate: 1, per: "1h", burst: 10 },
        );
      });
      for (let round = 0; round < 5; round++) {
        const subject = unique("client");
        const results = await Promise.all(
          Array.from({ length: 100 }, (_, i) => rules[i % 4]!.check(subject)),
        );
        expect(results.filter((r) => r.allowed)).toHaveLength(10);
        const used = await ioredis.hget(
          `${prefix}${storageKey(subkey, algorithm, name, subject)}`,
          "used",
        );
        expect(Number(used)).toBeCloseTo(10, 3);
      }
      expect(logger.lines).toEqual([]);
    }, 30_000);
  }

  test("stores an HMAC of the subject and lets Redis expire it", async () => {
    const name = unique("privacy");
    const rule = createRateLimiter({
      store: redisStore({ client: fromIoredis(ioredis), prefix }),
      secret: TEST_SECRET,
    }).rule({ name, limit: 5, window: "1m" });
    const subject = "203.0.113.7";
    const result = await rule.check(subject);

    const key = `${prefix}${storageKey(subkey, "fixed-window", name, subject)}`;
    const hash = await ioredis.hgetall(key);
    expect(JSON.stringify(hash)).not.toContain(subject);
    expect(Number(hash.used)).toBe(1);
    // Redis's own clock decided the window: about a minute from now, plus a second of slack.
    const ttl = await ioredis.pttl(key);
    expect(ttl).toBeGreaterThan(59_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
    expect(Math.abs(result.resetAt.getTime() - (Date.now() + 60_000))).toBeLessThan(5_000);
  });

  test("falls back to memory when Redis is down", async () => {
    const dead = new Redis("redis://127.0.0.1:1", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    dead.on("error", () => {});
    const clock = createTestClock(T0);
    const logger = recordingLogger();
    const rule = createRateLimiter({
      store: redisStore({ client: fromIoredis(dead), prefix }),
      secret: TEST_SECRET,
      clock,
      logger,
    }).rule({ name: "down", limit: 2, window: "1m" });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rule.check("x"));
    expect(results.map((r) => [r.allowed, r.degraded])).toEqual([
      [true, "memory"],
      [true, "memory"],
      [false, "memory"],
      [false, "memory"],
    ]);
    expect(logger.lines).toHaveLength(1);
    dead.disconnect();
  });

  test("reset inside a transaction needs the Postgres store", async () => {
    const rule = createRateLimiter({
      store: redisStore({ client: fromIoredis(ioredis), prefix }),
      secret: TEST_SECRET,
    }).rule({ name: unique("tx"), limit: 1, window: "1m" });
    const tx = { execute: async () => [] };
    await expect(rule.reset("x", { tx })).rejects.toThrow(/needs the Postgres store/);
  });
});
