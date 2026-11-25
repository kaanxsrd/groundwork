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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits until some statement in this database is waiting for a row lock. */
async function untilSomeoneWaitsForALock(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await database.current.rows<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((row?.waiting ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error("nobody started waiting for a lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Holds a statement's row changes in an open transaction on another connection until `commit`
 * is called, so a statement that runs meanwhile has to wait for them.
 */
async function holdOpen<T>(statement: ReturnType<typeof sql>) {
  const connection = database.current.connect({ max: 1 });
  const done = deferred();
  const ran = Promise.withResolvers<T[]>();
  const transaction = connection.db.transaction(async (tx) => {
    const result = (await tx.execute(statement)) as unknown as T[] | { rows: T[] };
    ran.resolve(Array.isArray(result) ? result : result.rows);
    await done.promise;
  });
  const rows = await ran.promise;
  return {
    rows,
    commit: async () => {
      done.resolve();
      await transaction;
    },
  };
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

describe("enqueueMany under concurrency", () => {
  test("calls that share keys in a different order don't deadlock", async () => {
    const db = database.current;
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
    for (let round = 0; round < 3; round++) {
      const type = unique("many-order");
      const [forward, backward] = [0, 1].map(() =>
        jobsOn(db.connect({ max: 1 })).define(type, { run(_payload: { n: number }) {} }),
      );
      const batch = (order: string[], n: number) =>
        order.map((dedupeKey) => ({ payload: { n }, dedupeKey }));
      // Before, Postgres aborted one of these with "deadlock detected".
      const [a, b] = await Promise.all([
        forward?.enqueueMany(batch(keys, 1)),
        backward?.enqueueMany(batch([...keys].reverse(), 2)),
      ]);
      const created = [...(a ?? []), ...(b ?? [])].filter((result) => result.created);
      expect(created).toHaveLength(keys.length);
      expect(await rowsOfType(type)).toHaveLength(keys.length);
    }
  }, 60_000);

  test("a duplicate in the call gets the new job's id when the old job finishes meanwhile", async () => {
    const type = unique("many-finished");
    const handle = jobsOn(database.current).define(type, { run(_payload: { n: number }) {} });
    const old = await handle.enqueue({ n: 0 }, { dedupeKey: "a" });
    // The old job finishes in a transaction that commits while enqueueMany waits for it.
    const finishing = await holdOpen(
      sql`update ${jobsTable} set status = 'completed', completed_at = now() where id = ${old.id}::uuid`,
    );
    const pending = handle.enqueueMany([
      { payload: { n: 1 }, dedupeKey: "a" },
      { payload: { n: 2 }, dedupeKey: "a" },
    ]);
    await untilSomeoneWaitsForALock();
    await finishing.commit();
    const [first, second] = await pending;
    expect(first?.created).toBe(true);
    expect(first?.id).not.toBe(old.id);
    // Before, the second got the finished job's id.
    expect(second).toEqual({ id: first?.id ?? "missing", created: false });
  });

  test("a duplicate that commits and finishes between the two statements is still found", async () => {
    const type = unique("many-vanished");
    const real = database.current.db;
    let afterFirst: (() => Promise<void>) | undefined;
    const db = {
      execute: async (query: SQLWrapper) => {
        const result = await real.execute(query);
        const hook = afterFirst;
        afterFirst = undefined;
        await hook?.();
        return result;
      },
    };
    const handle = jobsOn({ db: db as never }).define(type, { run(_payload: { n: number }) {} });
    // Another enqueuer's job with the same key, not committed yet when the statement starts.
    const other = await holdOpen<{ id: string }>(
      sql`insert into ${jobsTable} (type, payload, dedupe_key) values (${type}, '{}', 'b') returning id::text as id`,
    );
    const otherId = other.rows[0]?.id;
    // …and it finishes before enqueueMany looks for it again.
    afterFirst = async () => {
      await real.execute(
        sql`update ${jobsTable} set status = 'completed', completed_at = now() where id = ${otherId}::uuid`,
      );
    };
    const pending = handle.enqueueMany([
      { payload: { n: 1 }, dedupeKey: "b" },
      { payload: { n: 2 } },
    ]);
    await untilSomeoneWaitsForALock();
    await other.commit();
    // Before, this threw "found neither", after the other job had already been enqueued.
    const [duplicate, plain] = await pending;
    expect(duplicate).toEqual({ id: otherId ?? "missing", created: false });
    expect(plain?.created).toBe(true);
  });

  test("a duplicate whose key a replace takes between the two statements doesn't make it throw", async () => {
    for (const many of [false, true]) {
      const type = unique(many ? "taken-many" : "taken-one");
      const real = database.current.db;
      let afterFirst: (() => Promise<void>) | undefined;
      const db = {
        execute: async (query: SQLWrapper) => {
          const result = await real.execute(query);
          const hook = afterFirst;
          afterFirst = undefined;
          await hook?.();
          return result;
        },
      };
      const handle = jobsOn({ db: db as never }).define(type, { run(_payload: { n: number }) {} });
      // Another enqueuer's job with the same key, not committed yet when the statement starts.
      const other = await holdOpen<{ id: string }>(
        sql`insert into ${jobsTable} (type, payload, dedupe_key) values (${type}, '{}', 'k') returning id::text as id`,
      );
      const otherId = other.rows[0]?.id;
      // Before the job is looked up again, a worker claims it and a replace takes its key, as
      // enqueue({ replace: true }) does from a running job, but hasn't enqueued its own job yet.
      afterFirst = async () => {
        await real.execute(sql`update ${jobsTable} set status = 'running', attempts = 1,
          max_attempts = 1, locked_by = 'worker', locked_until = now() + interval '1 hour',
          dedupe_key = null where id = ${otherId}::uuid`);
      };
      const pending = many
        ? handle.enqueueMany([{ payload: { n: 1 }, dedupeKey: "k" }, { payload: { n: 2 } }])
        : handle.enqueue({ n: 1 }, { dedupeKey: "k" }).then((result) => [result]);
      await untilSomeoneWaitsForALock();
      await other.commit();
      // Before, this threw "found neither" (enqueueMany after enqueueing the rest). The key is
      // free now, so the job is enqueued with it.
      const results = await pending;
      expect(results.map((result) => result?.created)).toEqual(many ? [true, true] : [true]);
      const holders = await database.current.rows<{ id: string }>(
        sql`select id::text as id from ${jobsTable} where type = ${type} and dedupe_key = 'k'`,
      );
      expect(holders).toEqual([{ id: results[0]?.id ?? "missing" }]);
    }
  });

  test("tx goes on the call, not on a job", async () => {
    const handle = jobsOn(database.current).define(unique("many-tx-item"), {
      run(_payload: { n: number }) {},
    });
    const error = await thrown(() =>
      handle.enqueueMany([{ payload: { n: 1 }, tx: database.current.db } as never]),
    );
    expect((error as Error).message).toMatch(/^jobs\[0\]: tx goes on the call/);
  });

  test("the duplicate looked up after the snapshot is the live job, not an older finished one", async () => {
    for (const many of [false, true]) {
      const type = unique(many ? "fallback-many" : "fallback-one");
      const handle = jobsOn(database.current).define(type, { run(_payload: { n: number }) {} });
      // A job with the key that finished, but whose created_at is later than the live one's
      // (a long transaction enqueued the live one).
      await database.current.rows(sql`insert into ${jobsTable} (type, payload, dedupe_key, status, created_at, completed_at)
        values (${type}, '{}', 'k', 'completed', now() + interval '1 hour', now())`);
      const live = await holdOpen<{ id: string }>(
        sql`insert into ${jobsTable} (type, payload, dedupe_key, created_at)
          values (${type}, '{}', 'k', now() - interval '1 hour') returning id::text as id`,
      );
      const pending = many
        ? handle.enqueueMany([{ payload: { n: 1 }, dedupeKey: "k" }]).then(([result]) => result)
        : handle.enqueue({ n: 1 }, { dedupeKey: "k" });
      await untilSomeoneWaitsForALock();
      await live.commit();
      expect(await pending).toEqual({ id: live.rows[0]?.id ?? "missing", created: false });
    }
  });
});
