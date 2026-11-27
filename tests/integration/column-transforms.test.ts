// An app's postgres-js client may rename result columns and the keys inside JSON values
// (postgres.camel, postgres.pascal, postgres.kebab). groundwork's own reads must not depend on
// that, and the app's JSON must come back exactly as it was given, snake_case keys included.
import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createGroundwork } from "../../src/index.ts";
import {
  apiKeys,
  auditLog,
  idempotencyKeys,
  jobSchedules,
  jobs,
  rateLimits,
} from "../fixtures/schema.ts";
import { useTestDatabase } from "../support/database.ts";
import { recordingLogger, TEST_SECRET, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();
const clients: postgres.Sql[] = [];
afterAll(async () => {
  await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
});

const ORDER = { order_id: 7, ship_to: { postal_code: "1000" }, line_items: [{ sku_code: "a-1" }] };

describe.each(["camel", "pascal", "kebab"] as const)(
  "a postgres-js client with postgres.%s",
  (name) => {
    function setup() {
      const client = postgres(database.current.url, {
        max: 4,
        onnotice: () => {},
        transform: postgres[name],
      });
      clients.push(client);
      const logger = recordingLogger();
      const gw = createGroundwork({
        db: drizzle({ client }),
        tables: { apiKeys, auditLog, idempotencyKeys, jobs, jobSchedules, rateLimits },
        secret: TEST_SECRET,
        logger,
        audit: { actions: ["order.place"] },
        apiKeys: { namespace: "tst", scopes: { "orders:write": "Place orders" } },
        jobs: { rateLimitCleanup: false, idempotencyCleanup: false },
      });
      return { gw, logger };
    }

    test("rate limits count in the database, not in a fallback", async () => {
      const { gw, logger } = setup();
      const rule = gw.rateLimit.rule({ name: unique("orders"), limit: 2, window: "1m" });
      const results = [await rule.check("s"), await rule.check("s"), await rule.check("s")];
      expect(results.map((result) => [result.allowed, result.remaining])).toEqual([
        [true, 1],
        [true, 0],
        [false, 0],
      ]);
      // A failed read would have been logged before falling back to memory.
      expect(
        logger.lines.filter((line) => line.level === "error" || line.level === "warn"),
      ).toEqual([]);
    });

    test("API keys verify, with their metadata as given", async () => {
      const { gw } = setup();
      const { key } = await gw.apiKeys.create({
        name: "shop",
        scopes: ["orders:write"],
        metadata: ORDER,
        rateLimit: null,
      });
      const verified = await gw.apiKeys.verify(key, { scopes: ["orders:write"] });
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.key.metadata).toEqual(ORDER);
    });

    test("audit entries come back with their metadata and changes as given", async () => {
      const { gw } = setup();
      const requestId = unique("req");
      await gw.audit.record({
        actor: { type: "user", id: "u_1" },
        action: "order.place",
        requestId,
        metadata: ORDER,
        changes: { before: { order_status: "new" }, after: { order_status: "paid" } },
      });
      const { entries } = await gw.audit.query({ requestId });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.metadata).toEqual(ORDER);
      expect(entries[0]?.changes).toEqual({
        before: { order_status: "new" },
        after: { order_status: "paid" },
      });
    });

    test("jobs run with their payload as given, and keep their result", async () => {
      const { gw } = setup();
      const seen: unknown[] = [];
      const type = unique("order.ship");
      const ship = gw.jobs.define(type, {
        run(payload: typeof ORDER) {
          seen.push(payload);
          return { tracking_code: "T-1" };
        },
      });
      const { id } = await ship.enqueue(ORDER);
      expect(await gw.jobs.runOnce()).toMatchObject({ completed: 1, failed: 0 });
      expect(seen).toEqual([ORDER]);
      const record = await gw.jobs.get(id);
      expect(record).toMatchObject({ status: "completed", payload: ORDER, attempts: 1 });
      expect(record?.result).toEqual({ tracking_code: "T-1" });
      const health = await gw.jobs.health();
      expect(health.types.find((entry) => entry.type === type)).toMatchObject({
        pending: 0,
        failedLast24h: 0,
      });
    });

    test("idempotency replays the stored value as given", async () => {
      const { gw } = setup();
      const key = unique("idem");
      let calls = 0;
      const run = () =>
        gw.idempotency.run({ scope: "orders", key }, () => {
          calls++;
          return ORDER;
        });
      const first = await run();
      const second = await run();
      expect(first).toMatchObject({ ok: true, value: ORDER, replayed: false });
      expect(second).toMatchObject({ ok: true, value: ORDER, replayed: true });
      expect(calls).toBe(1);
    });

    test("the transform really renames what the database returns", async () => {
      // Without this, the tests above could pass on a client that transforms nothing.
      const client = clients.at(-1);
      if (!client) throw new Error("no client");
      const rows = await drizzle({ client }).execute(sql`select 1 as order_id`);
      expect(Object.keys(rows[0] ?? {})).toEqual([
        { camel: "orderId", pascal: "OrderId", kebab: "order-id" }[name],
      ]);
    });
  },
);
