import { describe, expect, test } from "bun:test";
import { type SQLWrapper, sql } from "drizzle-orm";
import { z } from "zod";
import { isGroundworkError } from "../../src/internal/errors.ts";
import { createJobs, type JobsOptions } from "../../src/jobs/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { jobSchedules, jobs as jobsTable } from "../fixtures/schema.ts";
import { type TestConnection, useTestDatabase } from "../support/database.ts";
import { recordingLogger, T0, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();

function jobsOn(target: Pick<TestConnection, "db">, extra: Partial<JobsOptions> = {}) {
  return createJobs({
    db: target.db,
    table: jobsTable,
    schedulesTable: jobSchedules,
    logger: recordingLogger(),
    ...extra,
  });
}

/** A database that records every statement it's given. */
function counting() {
  const statements: SQLWrapper[] = [];
  const db = {
    execute: (query: SQLWrapper) => {
      statements.push(query);
      return database.current.db.execute(query);
    },
  };
  return { db, statements };
}

interface Row extends Record<string, unknown> {
  id: string;
  payload: unknown;
  priority: number;
  max_attempts: number;
  run_at_ms: number;
  dedupe_key: string | null;
}

async function rowsOfType(type: string): Promise<Row[]> {
  return database.current.rows<Row>(sql`
    select id::text as id, payload, priority, max_attempts,
      (extract(epoch from run_at) * 1000)::float8 as run_at_ms, dedupe_key
    from ${jobsTable} where type = ${type} order by created_at, payload->>'n'`);
}

async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected it to throw");
}

describe("enqueueMany", () => {
  test("enqueues every job in one statement, in order, each with its own options", async () => {
    const clock = createTestClock(T0);
    const type = unique("many");
    const { db, statements } = counting();
    const handle = jobsOn({ db: db as never }, { clock }).define(type, {
      maxAttempts: 4,
      run(_payload: { n: number }) {},
    });
    const later = new Date(clock.now().getTime() + 3_600_000);

    const results = await handle.enqueueMany([
      { payload: { n: 1 } },
      { payload: { n: 2 }, delay: "5m" },
      { payload: { n: 3 }, runAt: later },
      { payload: { n: 4 }, priority: 7, maxAttempts: 2 },
    ]);
    expect(statements).toHaveLength(1);
    expect(results.every((result) => result.created)).toBe(true);

    const rows = await rowsOfType(type);
    // Each result is its own job's id, in the order the jobs were given.
    expect(rows.map((row) => row.id)).toEqual(results.map((result) => result.id));
    expect(rows.map((row) => [row.payload, row.priority, row.max_attempts, row.run_at_ms])).toEqual(
      [
        [{ n: 1 }, 0, 4, clock.now().getTime()],
        [{ n: 2 }, 0, 4, clock.now().getTime() + 300_000],
        [{ n: 3 }, 0, 4, later.getTime()],
        [{ n: 4 }, 7, 2, clock.now().getTime()],
      ],
    );
  });

  test("dedupeKey works against existing jobs and between jobs in one call", async () => {
    const type = unique("many-dedupe");
    const { db, statements } = counting();
    const handle = jobsOn({ db: db as never }).define(type, { run(_payload: { n: number }) {} });
    const existing = await handle.enqueue({ n: 0 }, { dedupeKey: "a" });
    statements.length = 0;

    const results = await handle.enqueueMany([
      { payload: { n: 1 }, dedupeKey: "a" },
      { payload: { n: 2 }, dedupeKey: "b" },
      { payload: { n: 3 }, dedupeKey: "b" },
      { payload: { n: 4 } },
    ]);
    expect(results[0]).toEqual({ id: existing.id, created: false });
    expect(results[1]?.created).toBe(true);
    // Like two enqueue() calls in a row: the first is created, the second gets its id.
    expect(results[2]).toEqual({ id: results[1]?.id ?? "missing", created: false });
    expect(results[3]?.created).toBe(true);
    // The existing job's id came back in the same statement.
    expect(statements).toHaveLength(1);

    const rows = await rowsOfType(type);
    expect(rows.map((row) => [row.payload, row.dedupe_key])).toEqual([
      [{ n: 0 }, "a"],
      [{ n: 2 }, "b"],
      [{ n: 4 }, null],
    ]);
  });

  test("concurrent calls with the same keys: each key is created once, and everyone gets its id", async () => {
    const type = unique("many-race");
    const db = database.current;
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    const handles = Array.from({ length: 10 }, () =>
      jobsOn(db.connect({ max: 2 })).define(type, { run(_payload: { n: number }) {} }),
    );
    const batches = await Promise.all(
      handles.map((handle, caller) =>
        handle.enqueueMany(keys.map((dedupeKey) => ({ payload: { n: caller }, dedupeKey }))),
      ),
    );
    for (let k = 0; k < keys.length; k++) {
      const forKey = batches.map((batch) => batch[k]);
      expect(forKey.filter((result) => result?.created)).toHaveLength(1);
      expect(new Set(forKey.map((result) => result?.id)).size).toBe(1);
    }
    expect(await rowsOfType(type)).toHaveLength(keys.length);
  });

  test("one bad job enqueues none, and the error says which", async () => {
    const type = unique("many-bad");
    const jobs = jobsOn(database.current);
    const handle = jobs.define(type, {
      schema: z.object({ orderId: z.string() }),
      run() {},
    });

    const invalid = await thrown(() =>
      handle.enqueueMany([
        { payload: { orderId: "o1" } },
        { payload: { orderId: "o2" } },
        { payload: { orderId: 3 as never } },
      ]),
    );
    expect(isGroundworkError(invalid) && invalid.code).toBe("invalid_argument");
    expect((invalid as Error).message).toMatch(/^jobs\[2\]: Invalid payload/);

    const both = await thrown(() =>
      handle.enqueueMany([
        { payload: { orderId: "o1" } },
        { payload: { orderId: "o2" }, delay: "1m", runAt: new Date() },
      ]),
    );
    expect((both as Error).message).toBe("jobs[1]: Pass runAt or delay, not both.");

    // A bare payload would otherwise be read as options, and enqueued without one.
    const bare = await thrown(() => handle.enqueueMany([{ orderId: "o1" } as never]));
    expect((bare as Error).message).toMatch(/^jobs\[0\]: each job needs a payload/);

    expect(await rowsOfType(type)).toEqual([]);
  });

  test("inside a transaction, the jobs exist only if it commits", async () => {
    const type = unique("many-tx");
    const handle = jobsOn(database.current).define(type, { run(_payload: { n: number }) {} });
    const rollback = new Error("rollback");

    await expect(
      database.current.db.transaction(async (tx) => {
        await handle.enqueueMany([{ payload: { n: 1 } }, { payload: { n: 2 } }], { tx });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await rowsOfType(type)).toEqual([]);

    await database.current.db.transaction(async (tx) => {
      await handle.enqueueMany([{ payload: { n: 1 } }, { payload: { n: 2 } }], { tx });
    });
    expect(await rowsOfType(type)).toHaveLength(2);
  });

  test("the jobs run like any other, and a missing payload is stored as enqueue() stores it", async () => {
    const type = unique("many-run");
    const jobs = jobsOn(database.current);
    const seen: unknown[] = [];
    const handle = jobs.define(type, {
      run(payload: { n: number } | undefined) {
        seen.push(payload);
      },
    });
    await handle.enqueue(undefined);
    await handle.enqueueMany([{ payload: { n: 1 } }, { payload: undefined }]);

    const types = await database.current.rows<{ type: string }>(
      sql`select jsonb_typeof(payload) as type from ${jobsTable} where type = ${type} order by created_at`,
    );
    expect(types.map((row) => row.type).sort()).toEqual(["null", "null", "object"]);
    expect((await jobs.runOnce()).completed).toBe(3);
    expect(seen).toContainEqual({ n: 1 });
    expect(seen.filter((payload) => payload === null)).toHaveLength(2);
  });

  test("an empty list sends nothing, and more than 1,000 jobs are refused", async () => {
    const { db, statements } = counting();
    const handle = jobsOn({ db: db as never }).define(unique("many-size"), {
      run(_payload: { n: number }) {},
    });
    expect(await handle.enqueueMany([])).toEqual([]);
    expect(statements).toHaveLength(0);

    const tooMany = Array.from({ length: 1_001 }, (_, n) => ({ payload: { n } }));
    expect(await thrown(() => handle.enqueueMany(tooMany))).toMatchObject({
      code: "invalid_argument",
      message: expect.stringContaining("at most 1000"),
    });
    const exactly = Array.from({ length: 1_000 }, (_, n) => ({ payload: { n } }));
    const results = await handle.enqueueMany(exactly);
    expect(new Set(results.map((result) => result.id)).size).toBe(1_000);
    expect(statements).toHaveLength(1);
  });
});
