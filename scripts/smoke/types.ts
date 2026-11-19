// Type-checked in the smoke project with several TypeScript versions, never run. Each expected
// error below becomes a build failure if the types it guards collapse to `any`.

import { sql } from "drizzle-orm";
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
import { createApiKeys, type VerifyResult } from "groundwork/api-keys";
import { type AuditEntry, createAuditLog, diff } from "groundwork/audit";
import { createJobs, type RunSummary, type StandardSchemaV1 } from "groundwork/jobs";
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

// Audit actions and entity types are inferred from the config, without as const.
const { auditLog } = groundworkTables();
const audit = createAuditLog({
  db: pgDb,
  table: auditLog,
  actions: ["post.create", "post.update"],
  entityTypes: ["post"],
});
const changes = diff({ title: "a", views: 1 }, { title: "b", views: 1 });
const recorded: Promise<AuditEntry<"post.create" | "post.update", "post">> = audit.record(
  {
    actor: { type: "user", id: 1 },
    action: "post.update",
    entity: { type: "post", id: 1 },
    changes,
  },
  { tx: jsDb },
);
// @ts-expect-error not a declared action
audit.record({ actor: { type: "user" }, action: "post.delete" });
// @ts-expect-error not a declared entity type
audit.record({ actor: { type: "user" }, action: "post.create", entity: { type: "user" } });
const page = audit.query({ action: ["post.create"], where: sql`true`, order: "asc", limit: 10 });
const typed = createGroundwork({
  db: jsDb,
  tables: { auditLog },
  secret,
  audit: { actions: ["invoice.send"] },
});
typed.audit.record({ actor: { type: "system" }, action: "invoice.send" });
// @ts-expect-error not a declared action
typed.audit.record({ actor: { type: "system" }, action: "invoice.void" });

// API keys: scopes and wildcards are typed from the config.
const { apiKeys } = groundworkTables();
const keys = createApiKeys({
  db: jsDb,
  table: apiKeys,
  secret,
  namespace: "vnt",
  scopes: { "posts:read": "Read posts", "posts:write": "Write posts" },
  defaultRateLimit: null,
});
keys.create({
  name: "CI",
  scopes: ["posts:read", "posts:*"],
  allowedIps: ["10.0.0.0/8"],
  expiresIn: "90d",
});
// @ts-expect-error not a declared scope
keys.create({ name: "CI", scopes: ["users:read"] });
const verified: Promise<VerifyResult<"posts:read" | "posts:write">> = keys.verify(
  new Request("https://x.test"),
  {
    scopes: ["posts:write"],
    ip: "203.0.113.7",
  },
);
// @ts-expect-error verify needs declared scopes, not wildcards
keys.verify("key", { scopes: ["posts:*"] });
const gwKeys = createGroundwork({
  db: jsDb,
  tables: { apiKeys, rateLimits },
  secret,
  apiKeys: { namespace: "vnt", scopes: { "billing:read": "Read invoices" } },
});
gwKeys.apiKeys.verify("key", { scopes: ["billing:read"] });
// @ts-expect-error not a declared scope
gwKeys.apiKeys.verify("key", { scopes: ["posts:read"] });

// Jobs: payloads are typed from a Standard Schema or from run's parameter.
const { jobs: jobsTable, jobSchedules } = groundworkTables();
const jobs = createJobs({ db: jsDb, table: jobsTable, schedulesTable: jobSchedules });
declare const orderSchema: StandardSchemaV1<
  { orderId: string },
  { orderId: string; copies: number }
>;
const receipt = jobs.define("email.receipt", {
  schema: orderSchema,
  maxAttempts: 5,
  backoff: { base: "30s", max: "1h" },
  run(payload, { signal, attempt }) {
    const copies: number = payload.copies;
    return { copies, attempt, aborted: signal.aborted };
  },
});
receipt.enqueue({ orderId: "o1" }, { tx: jsDb, dedupeKey: "receipt:o1", delay: "5m" });
// @ts-expect-error orderId must be a string
receipt.enqueue({ orderId: 1 });
const annotated = jobs.define("user.welcome", {
  run(payload: { userId: number }) {
    return payload.userId;
  },
});
// @ts-expect-error userId must be a number
annotated.enqueue({ userId: "x" });
jobs.schedule("reports.nightly", { every: "1d" }, ({ scheduledAt }) => scheduledAt.toISOString());
const worked: Promise<RunSummary> = jobs.work({
  concurrency: 4,
  pollInterval: "1s",
  signal: AbortSignal.timeout(1),
});

void [window, noUnit, code, opsName, result, retry, recorded, page, verified, worked];
