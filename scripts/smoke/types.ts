// Type-checked in the smoke project with several TypeScript versions, never run. Each expected
// error below becomes a build failure if the types it guards collapse to `any`.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createGroundwork,
  type Duration,
  GroundworkError,
  type GroundworkErrorCode,
  isGroundworkError,
  type Logger,
} from "groundwork";
import { createRateLimiter, type RateLimitResult, redisStore } from "groundwork/rate-limit";
import { groundworkTables } from "groundwork/schema";
import { createTestClock } from "groundwork/testing";

const window: Duration = "15m";
// @ts-expect-error a duration needs a unit
const noUnit: Duration = "15";
// @ts-expect-error unknown error code
new GroundworkError("not_a_code", "x");
const code: GroundworkErrorCode = new GroundworkError("invalid_argument", "x").code;
const logger: Logger = console;
const maybe: unknown = new Error("x");
if (isGroundworkError(maybe)) {
  const narrowed: GroundworkErrorCode = maybe.code;
  void narrowed;
}

const { rateLimits } = groundworkTables();
const ops = groundworkTables({ prefix: "", schema: "ops" });
const opsName: "ops" = ops.schema.schemaName;
// @ts-expect-error there is no schema object without the schema option
groundworkTables().schema;

// Databases from either driver, typed with the app's own schema, are accepted as they are.
declare const pgDb: NodePgDatabase<{ rateLimits: typeof rateLimits }>;
declare const jsDb: PostgresJsDatabase<{ ops: typeof ops.rateLimits }>;
const secret = "x".repeat(32);
const redis = redisStore({ client: { eval: async () => [] } });

const limiter = createRateLimiter({
  db: pgDb,
  table: rateLimits,
  secret,
  clock: createTestClock(),
});
createRateLimiter({ db: jsDb, table: ops.rateLimits, secret, onError: "deny", timeout: "250ms" });
createRateLimiter({ store: redis, secret });
// @ts-expect-error a store and a database at once
createRateLimiter({ db: jsDb, table: rateLimits, store: redis, secret });

const rule = limiter.rule({ name: "login:ip", limit: 5, window: "15m" });
limiter.rule({ name: "api", algorithm: "token-bucket", rate: 10, per: "1s", burst: 120 });
// @ts-expect-error fixed-window options can't take a rate
limiter.rule({ name: "x", limit: 5, window: "15m", rate: 1 });
// @ts-expect-error durations need a unit
limiter.rule({ name: "x", limit: 5, window: 900 });
const result: Promise<RateLimitResult> = rule.check("203.0.113.9", { cost: 2 });

const gw = createGroundwork({ db: pgDb, tables: { rateLimits }, secret, logger });
const retry: number = (await gw.rateLimit.rule({ name: "y", limit: 1, window: "1m" }).check("x"))
  .retryAfterMs;

void [window, noUnit, code, opsName, result, retry];
