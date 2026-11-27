// enqueue({ dedupeKey, replace: true }): debouncing a job, as graphile-worker's "replace" mode.
import { describe, expect, test } from "bun:test";
import { type SQLWrapper, sql } from "drizzle-orm";
import { createJobs, type JobsOptions } from "../../src/jobs/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { altJobSchedules, altJobs, jobSchedules, jobs as jobsTable } from "../fixtures/schema.ts";
import { type TestConnection, useTestDatabase } from "../support/database.ts";
import { recordingLogger, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();

function jobsOn(target: Pick<TestConnection, "db">, extra: Partial<JobsOptions> = {}) {
  const logger = recordingLogger();
  const jobs = createJobs({
    db: target.db,
    table: jobsTable,
    schedulesTable: jobSchedules,
    logger,
    ...extra,
  });
  return Object.assign(jobs, { logger });
}

interface Row extends Record<string, unknown> {
  id: string;
  status: string;
  payload: unknown;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  claims: number;
  result: unknown;
  run_at_ms: number;
}

/** Rows by their payload's n, for jobs created at the same test-clock instant. */
function byPayload(rows: Row[]): Row[] {
  const n = (row: Row) => (row.payload as { n: number }).n;
  return [...rows].sort((a, b) => n(a) - n(b));
}

// JSON as text, as groundwork reads it: a client's column transform would rename its keys.
async function rowsOfType(type: string): Promise<Row[]> {
  const rows = await database.current.rows<Row & { payload: string; result: string | null }>(sql`
    select id::text as id, status, payload::text as payload, dedupe_key, attempts, max_attempts,
      claims, result::text as result, (extract(epoch from run_at) * 1000)::float8 as run_at_ms
    from ${jobsTable} where type = ${type} order by created_at, id`);
  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload),
    result: row.result === null ? null : JSON.parse(row.result),
  }));
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("enqueue with replace", () => {
  test("the pending job takes the latest payload and timing, and keeps its id", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("debounce");
    const jobs = jobsOn(database.current, { clock });
    const seen: unknown[] = [];
    const digest = jobs.define(type, {
      run(payload: { n: number }) {
        seen.push(payload);
      },
    });
    const options = { dedupeKey: "digest:u1", delay: "5m", replace: true } as const;

    const first = await digest.enqueue({ n: 1 }, options);
    expect(first.created).toBe(true);
    clock.advance("1m");
    const second = await digest.enqueue({ n: 2 }, options);
    expect(second).toEqual({ id: first.id, created: false });

    const [row] = await rowsOfType(type);
    expect(row?.payload).toEqual({ n: 2 });
    // Five minutes after the latest call, not the first.
    expect(row?.run_at_ms).toBe(clock.now().getTime() + 300_000);

    clock.advance("4m");
    expect((await jobs.runOnce()).claimed).toBe(0);
    clock.advance("1m");
    expect((await jobs.runOnce()).completed).toBe(1);
    expect(seen).toEqual([{ n: 2 }]);
  });

  test("without replace, dedupeKey still keeps the first job as it was", async () => {
    const type = unique("keep");
    const handle = jobsOn(database.current).define(type, { run(_payload: { n: number }) {} });
    const first = await handle.enqueue({ n: 1 }, { dedupeKey: "k", delay: "1m" });
    expect(await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: false })).toEqual({
      id: first.id,
      created: false,
    });
    expect((await rowsOfType(type)).map((row) => row.payload)).toEqual([{ n: 1 }]);
  });

  test("a running job keeps running without its key, and the latest payload is enqueued", async () => {
    const type = unique("running");
    const jobs = jobsOn(database.current);
    const seen: number[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = jobs.define(type, {
      timeout: false,
      async run(payload: { n: number }) {
        seen.push(payload.n);
        if (payload.n === 1) await held;
        return payload.n;
      },
    });
    const first = await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    const running = jobs.runOnce({ budgetMs: 50 });
    await waitUntil(() => seen.length === 1);

    // The running job may have read its data already, so this change gets a job of its own.
    const second = await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true });
    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    // A further change replaces the new pending job, not the running one.
    expect(await handle.enqueue({ n: 3 }, { dedupeKey: "k", replace: true })).toEqual({
      id: second.id,
      created: false,
    });
    expect((await rowsOfType(type)).map((row) => [row.status, row.dedupe_key])).toEqual([
      ["running", null],
      ["pending", "k"],
    ]);

    release();
    await running;
    await jobs.runOnce();
    expect(seen).toEqual([1, 3]);
    expect((await rowsOfType(type)).map((row) => [row.status, row.result])).toEqual([
      ["completed", 1],
      ["completed", 3],
    ]);
  }, 30_000);

  test("a running job whose worker is gone is replaced in place, and that worker can't finish it", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("gone");
    const releases: (() => void)[] = [];
    const victim = jobsOn(database.current, { clock, workerId: "victim", lease: "30s" });
    victim.define(type, {
      timeout: false,
      run: () => new Promise<string>((resolve) => releases.push(() => resolve("victim"))),
    });
    const producer = jobsOn(database.current, { clock });
    const handle = producer.define(type, { run(_payload: { n: number }) {} });
    const first = await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    const victimRun = victim.runOnce({ budgetMs: 50 });
    await waitUntil(() => releases.length === 1);

    clock.advance("31s");
    expect(await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true })).toEqual({
      id: first.id,
      created: false,
    });
    expect(
      (await rowsOfType(type)).map((row) => [row.status, row.payload, row.attempts, row.claims]),
    ).toEqual([["pending", { n: 2 }, 0, 1]]);

    const rescuer = jobsOn(database.current, { clock, workerId: "rescuer" });
    rescuer.define(type, { run: (payload: { n: number }) => `rescued ${payload.n}` });
    expect(await rescuer.runOnce()).toMatchObject({ claimed: 1, completed: 1 });

    // The victim wakes up: its attempt no longer owns the job, so its result is dropped. (It
    // wakes up only now because, still inside its budget, it would claim the pending job again.)
    for (const done of releases) done();
    expect(await victimRun).toMatchObject({ claimed: 1, completed: 0 });
    expect(victim.logger.lines.map((line) => line.message)).toEqual([
      expect.stringContaining("lost its lease"),
    ]);
    expect(
      (await rowsOfType(type)).map((row) => [row.status, row.attempts, row.claims, row.result]),
    ).toEqual([["completed", 1, 2, "rescued 2"]]);
  }, 30_000);

  test("concurrent replaces of one key: one job, and every caller gets its id", async () => {
    const type = unique("race");
    const db = database.current;
    const handles = Array.from({ length: 4 }, () =>
      jobsOn(db.connect({ max: 5 })).define(type, { run(_payload: { n: number }) {} }),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        handles[n % handles.length]?.enqueue({ n }, { dedupeKey: "k", delay: "1h", replace: true }),
      ),
    );
    expect(results.filter((result) => result?.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result?.id)).size).toBe(1);
    const rows = await rowsOfType(type);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({ n: expect.any(Number) });
  });

  test("while workers run, the latest payload always runs, and the key is never held twice", async () => {
    const type = unique("stress");
    const db = database.current;
    const seen: number[] = [];
    const workers = Array.from({ length: 2 }, (_, i) => {
      const worker = jobsOn(db.connect({ max: 4 }), { workerId: `worker-${i}` });
      worker.define(type, {
        async run(payload: { n: number }) {
          seen.push(payload.n);
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 15));
        },
      });
      return worker;
    });
    const stop = new AbortController();
    const working = workers.map((worker) =>
      worker.work({ concurrency: 2, pollInterval: "10ms", signal: stop.signal }),
    );
    const producer = jobsOn(db).define(type, { run(_payload: { n: number }) {} });
    const last = 60;
    for (let n = 1; n <= last; n++) {
      await producer.enqueue({ n }, { dedupeKey: "k", replace: true });
      const [held] = await db.rows<{ holders: number }>(
        sql`select count(*)::int as holders from ${jobsTable}
          where type = ${type} and dedupe_key = 'k' and status in ('pending', 'running')`,
      );
      expect(held?.holders).toBeLessThanOrEqual(1);
      if (n % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await waitUntil(async () => {
      const [row] = await db.rows<{ active: number }>(
        sql`select count(*)::int as active from ${jobsTable}
          where type = ${type} and status in ('pending', 'running')`,
      );
      return row?.active === 0;
    });
    stop.abort();
    await Promise.all(working);
    expect(seen).toContain(last);
    expect(Math.max(...seen)).toBe(last);
  }, 60_000);

  test("inside a rolled-back transaction, nothing is replaced", async () => {
    const type = unique("tx");
    const handle = jobsOn(database.current).define(type, { run(_payload: { n: number }) {} });
    await handle.enqueue({ n: 1 }, { dedupeKey: "k", delay: "1h" });
    const rollback = new Error("rollback");
    await expect(
      database.current.db.transaction(async (tx) => {
        await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true, tx });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await rowsOfType(type)).map((row) => row.payload)).toEqual([{ n: 1 }]);
  });

  test("replace needs a dedupeKey, and enqueueMany doesn't take it", async () => {
    const handle = jobsOn(database.current).define(unique("bad"), {
      run(_payload: { n: number }) {},
    });
    await expect(handle.enqueue({ n: 1 }, { replace: true })).rejects.toThrow(
      /replace needs a dedupeKey/,
    );
    await expect(
      handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: "yes" as never }),
    ).rejects.toThrow(/replace must be true or false/);
    await expect(
      handle.enqueueMany([{ payload: { n: 1 }, dedupeKey: "k", replace: true } as never]),
    ).rejects.toThrow(/jobs\[0\]: enqueueMany doesn't take replace/);
  });

  test("a replaced job gets its full maxAttempts, even if its last attempt was running", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("budget");
    const releases: (() => void)[] = [];
    const victim = jobsOn(database.current, { clock, workerId: "victim", lease: "30s" });
    victim.define(type, {
      timeout: false,
      run: () => new Promise<string>((resolve) => releases.push(() => resolve("victim"))),
    });
    const handle = jobsOn(database.current, { clock }).define(type, {
      maxAttempts: 1,
      run(_payload: { n: number }) {},
    });
    await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    const victimRun = victim.runOnce({ budgetMs: 50 });
    await waitUntil(() => releases.length === 1);

    // Its only attempt is running, and its worker is gone: the replace must still get a run.
    clock.advance("31s");
    expect((await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true })).created).toBe(false);
    const seen: number[] = [];
    const rescuer = jobsOn(database.current, { clock, workerId: "rescuer" });
    rescuer.define(type, {
      run(payload: { n: number }) {
        seen.push(payload.n);
      },
    });
    // Before, this failed it for good without running it ("stopped before finishing").
    expect(await rescuer.runOnce()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(seen).toEqual([2]);
    for (const done of releases) done();
    await victimRun;
  }, 30_000);

  test("a pending job in backoff gets its full maxAttempts again when it's replaced", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("backoff");
    const jobs = jobsOn(database.current, { clock });
    const handle = jobs.define(type, {
      maxAttempts: 2,
      run(payload: { n: number }) {
        if (payload.n === 1) throw new Error("not yet");
      },
    });
    await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    expect((await jobs.runOnce()).retried).toBe(1);
    await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true });
    const [row] = await database.current.rows<{
      attempts: number;
      max_attempts: number;
      last_error: string | null;
    }>(sql`select attempts, max_attempts, last_error from ${jobsTable} where type = ${type}`);
    // The new payload starts again from attempt 1, with the call's maxAttempts.
    expect(row).toEqual({ attempts: 0, max_attempts: 2, last_error: null });
    expect((await jobs.runOnce()).completed).toBe(1);
  });

  test("a replaced job's attempts and backoff start again, and retry gives it the call's maxAttempts", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("fresh");
    const jobs = jobsOn(database.current, { clock });
    const seen: [number, number][] = [];
    const handle = jobs.define(type, {
      maxAttempts: 2,
      backoff: { delays: ["1s", "1h"] },
      run(payload: { n: number }, { attempt }) {
        seen.push([payload.n, attempt]);
        throw new Error("fails");
      },
    });
    await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    expect((await jobs.runOnce()).retried).toBe(1);
    const { id } = await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true });
    expect((await jobs.runOnce()).retried).toBe(1);
    // Attempt 1 of the new payload, so the ladder's first step. Before: attempt 2, and 1h.
    expect(seen).toEqual([
      [1, 1],
      [2, 1],
    ]);
    const [waiting] = await rowsOfType(type);
    expect(waiting?.run_at_ms).toBe(clock.now().getTime() + 1_000);

    clock.advance("1s");
    expect((await jobs.runOnce()).failed).toBe(1);
    expect(await jobs.retry(id)).toBe(true);
    for (let i = 0; i < 4; i++) {
      await jobs.runOnce();
      clock.advance("1h");
    }
    // Two tries after the retry, as maxAttempts says. Before, three (1 used + 2).
    expect(seen.slice(3)).toEqual([
      [2, 1],
      [2, 2],
    ]);
    expect((await rowsOfType(type)).map((row) => [row.status, row.attempts, row.claims])).toEqual([
      ["failed", 2, 5],
    ]);
  });

  test("maxAttempts goes up to 2,147,483,646, and a job at the limit is still claimed and failed", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("huge");
    const other = unique("innocent");
    const releases: (() => void)[] = [];
    const victim = jobsOn(database.current, { clock, workerId: "victim", lease: "30s" });
    victim.define(type, {
      maxAttempts: 2_147_483_646,
      timeout: false,
      run: (payload: { n: number }) =>
        payload.n === 1 ? new Promise<void>((resolve) => releases.push(resolve)) : undefined,
    });
    const handle = jobsOn(database.current, { clock }).define(type, {
      maxAttempts: 2_147_483_646,
      run(_payload: { n: number }) {},
    });
    await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    const victimRun = victim.runOnce({ budgetMs: 50 });
    await waitUntil(() => releases.length === 1);
    // A replace takes the key, which sets the running job's attempts to its maxAttempts. Then
    // its worker stops, and the next claim takes attempts one past it.
    expect((await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true })).created).toBe(true);
    clock.advance("31s");
    // And a job whose worker kept dying even past that: the claim mustn't overflow either.
    await database.current.rows(sql`insert into ${jobsTable}
      (type, payload, status, attempts, max_attempts, locked_by, locked_until, run_at)
      values (${type}, '{"n":3}', 'running', 2147483647, 2147483646, 'gone',
        ${clock.now().toISOString()}::timestamptz - interval '1 minute',
        ${clock.now().toISOString()}::timestamptz - interval '1 minute')`);

    const rescuer = jobsOn(database.current, { clock, workerId: "rescuer" });
    rescuer.define(type, { maxAttempts: 2_147_483_646, run(_payload: { n: number }) {} });
    await rescuer.define(other, { run() {} }).enqueue(undefined);
    // Before, "integer out of range" failed every claim, so no job of any type ran again.
    expect(await rescuer.runOnce()).toMatchObject({ claimed: 4, completed: 2, failed: 2 });
    expect(
      byPayload(await rowsOfType(type)).map((row) => [row.payload, row.status, row.attempts]),
    ).toEqual([
      [{ n: 1 }, "failed", 2_147_483_647],
      [{ n: 2 }, "completed", 1],
      [{ n: 3 }, "failed", 2_147_483_647],
    ]);
    for (const done of releases) done();
    await victimRun;

    // Above it is refused up front, not by Postgres.
    expect(() =>
      rescuer.define(unique("too-many"), { maxAttempts: 2_147_483_647, run() {} }),
    ).toThrow(/maxAttempts of ".*" must be an integer from 1 to 2,147,483,646/);
    await expect(handle.enqueue({ n: 4 }, { maxAttempts: 2_147_483_647 })).rejects.toThrow(
      /^maxAttempts must be an integer from 1 to 2,147,483,646/,
    );
  }, 30_000);

  test("inside a transaction that began before a lease ran out, replace still sees it ran out", async () => {
    const type = unique("old-tx");
    const handle = jobsOn(database.current).define(type, { run(_payload: { n: number }) {} });
    // A running job whose lease runs out in a second, and whose worker is gone.
    const [dead] = await database.current.rows<{ id: string }>(sql`insert into ${jobsTable}
      (type, payload, status, attempts, claims, locked_by, locked_until, run_at, dedupe_key)
      values (${type}, '{"n":1}', 'running', 1, 1, 'gone', now() + interval '1 second',
        now() + interval '1 second', 'k') returning id::text as id`);
    const result = await database.current.db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // now() is still when the transaction began, before the lease ran out. Before, the job
      // looked alive, so it gave up its key and was failed for good with its old payload.
      return handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true, tx });
    });
    expect(result).toEqual({ id: dead?.id ?? "missing", created: false });
    expect((await rowsOfType(type)).map((row) => [row.status, row.payload, row.attempts])).toEqual([
      ["pending", { n: 2 }, 0],
    ]);
  }, 30_000);

  test("a running job whose lease runs out during the replace is replaced in place", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("expires-midway");
    const releases: (() => void)[] = [];
    const victim = jobsOn(database.current, { clock, workerId: "victim", lease: "30s" });
    victim.define(type, {
      timeout: false,
      run: (payload: { n: number }) =>
        payload.n === 1 ? new Promise<void>((resolve) => releases.push(resolve)) : undefined,
    });
    // Runs a hook after the next statement, before the call sends another.
    let afterNext: (() => void) | undefined;
    const real = database.current.db;
    const db = {
      async execute(query: SQLWrapper) {
        const result = await real.execute(query);
        const hook = afterNext;
        afterNext = undefined;
        hook?.();
        return result;
      },
    };
    const handle = jobsOn({ db: db as never }, { clock }).define(type, {
      run(_payload: { n: number }) {},
    });
    const first = await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    const victimRun = victim.runOnce({ budgetMs: 50 });
    await waitUntil(() => releases.length === 1);

    // The first statement sees a live lease, and the lease runs out before the second. Before,
    // the second took the key from the dead worker's job and cut its retries, so that job failed
    // for good with its old payload when it was next claimed.
    afterNext = () => clock.advance("31s");
    expect(await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true })).toEqual({
      id: first.id,
      created: false,
    });
    expect(
      (await rowsOfType(type)).map((row) => [row.status, row.payload, row.dedupe_key]),
    ).toEqual([["pending", { n: 2 }, "k"]]);
    for (const done of releases) done();
    await victimRun;
  }, 30_000);

  test("a running job that gave up its key isn't retried, so the newest payload runs last", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("superseded");
    const seen: number[] = [];
    let failFirst!: () => void;
    const firstFails = new Promise<void>((resolve) => {
      failFirst = resolve;
    });
    const define = (worker: ReturnType<typeof jobsOn>) =>
      worker.define(type, {
        timeout: false,
        async run(payload: { n: number }) {
          seen.push(payload.n);
          if (payload.n === 1) {
            await firstFails;
            throw new Error("the stale run failed");
          }
        },
      });
    const busy = jobsOn(database.current, { clock, workerId: "busy" });
    const handle = define(busy);
    await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    const busyRun = busy.runOnce({ budgetMs: 50 });
    await waitUntil(() => seen.length === 1);

    // A newer change: the running job gives up its key, and the new job runs and completes.
    expect((await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true })).created).toBe(true);
    const other = jobsOn(database.current, { clock, workerId: "other" });
    define(other);
    expect(await other.runOnce()).toMatchObject({ completed: 1 });

    // Then the superseded run fails. It must not be retried with its stale payload.
    failFirst();
    await busyRun;
    clock.advance("2h");
    expect((await other.runOnce()).claimed).toBe(0);
    expect(seen).toEqual([1, 2]);
    expect(
      byPayload(await rowsOfType(type)).map((row) => [row.payload, row.status, row.dedupe_key]),
    ).toEqual([
      [{ n: 1 }, "failed", null],
      [{ n: 2 }, "completed", "k"],
    ]);

    // Retrying it by hand runs it with its full maxAttempts. Before, with as many as it had used.
    const stale = byPayload(await rowsOfType(type))[0];
    expect(stale && (await other.retry(stale.id))).toBe(true);
    const [retried] = byPayload(await rowsOfType(type));
    expect(retried && [retried.status, retried.attempts, retried.max_attempts]).toEqual([
      "pending",
      0,
      5,
    ]);
  }, 30_000);

  test("a stalled worker can't finish a job once it's claimed again, even with the same attempt number", async () => {
    // attempts start again after a replace or retry, so a worker that stalled could find its
    // attempt number current again, under the same worker id. Claims never go down.
    for (const via of ["replace", "retry"] as const) {
      const clock = createTestClock("2026-04-01T00:00:00Z");
      const type = unique(`fence-${via}`);
      const releases = new Map<number, () => void>();
      const results: string[] = [];
      // Two instances with one worker id, as one process would be after it stalls and recovers.
      const sameWorker = () => {
        const worker = jobsOn(database.current, { clock, workerId: "w", lease: "30s" });
        worker.define(type, {
          maxAttempts: 1,
          timeout: false,
          run: (payload: { n: number }) =>
            new Promise<string>((resolve) =>
              releases.set(payload.n, () => {
                results.push(`n${payload.n}`);
                resolve(`n${payload.n}`);
              }),
            ),
        });
        return worker;
      };
      const stalled = sameWorker();
      const producer = jobsOn(database.current, { clock });
      const handle = producer.define(type, { maxAttempts: 1, run(_payload: { n: number }) {} });
      const { id } = await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
      const stalledRun = stalled.runOnce({ budgetMs: 50 });
      await waitUntil(() => releases.has(1));
      clock.advance("31s");

      if (via === "replace") {
        await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true });
      } else {
        // The lease ran out on its only attempt: the next claim fails it, then it's retried.
        expect(await producer.runOnce()).toMatchObject({ claimed: 1, failed: 1 });
        expect(await producer.retry(id)).toBe(true);
        await database.current.rows(
          sql`update ${jobsTable} set payload = '{"n":2}' where id = ${id}::uuid`,
        );
      }
      // Claimed again by worker "w": attempt 1, as the stalled run's was.
      const recovered = sameWorker();
      const recoveredRun = recovered.runOnce({ budgetMs: 50 });
      await waitUntil(() => releases.has(2));
      expect((await rowsOfType(type)).map((row) => [row.status, row.attempts])).toEqual([
        ["running", 1],
      ]);

      // The stalled run finishes first. Before, its attempt number matched, and it completed
      // the job with the old payload's result while the new run was still going.
      releases.get(1)?.();
      expect(await stalledRun).toMatchObject({ completed: 0 });
      expect(stalled.logger.lines.map((line) => line.message)).toEqual([
        expect.stringContaining("lost its lease"),
      ]);
      releases.get(2)?.();
      expect(await recoveredRun).toMatchObject({ completed: 1 });
      expect((await rowsOfType(type)).map((row) => [row.status, row.result])).toEqual([
        ["completed", "n2"],
      ]);
      // One claim each for the stalled and the recovered run, and one that failed the job.
      expect(await producer.get(id)).toMatchObject({
        attempts: 1,
        claims: via === "replace" ? 2 : 3,
      });
    }
  }, 30_000);

  test("a worker on 0.3 that takes over a stalled job fences out the stalled 0.4 run", async () => {
    // 0.3 claims bump attempts and set locked_by, but don't know claims.
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("mixed");
    const releases: (() => void)[] = [];
    const stalled = jobsOn(database.current, { clock, workerId: "new", lease: "30s" });
    const handle = stalled.define(type, {
      timeout: false,
      run: () => new Promise<string>((resolve) => releases.push(() => resolve("stale"))),
    });
    const { id } = await handle.enqueue(undefined);
    const stalledRun = stalled.runOnce({ budgetMs: 50 });
    await waitUntil(() => releases.length === 1);
    clock.advance("31s");
    await database.current.rows(sql`update ${jobsTable} set status = 'running',
      attempts = attempts + 1, locked_by = 'old', locked_until = now() + interval '1 hour',
      run_at = now() + interval '1 hour' where id = ${id}::uuid`);

    for (const done of releases) done();
    expect(await stalledRun).toMatchObject({ completed: 0 });
    expect(await stalled.get(id)).toMatchObject({ status: "running", lockedBy: "old", claims: 1 });
  }, 30_000);

  test("a jobs table without the claims column fails with a message that says to migrate", async () => {
    const message =
      /^The jobs table is missing a column this version of groundwork uses \(.*claims.*\)\. Generate a migration with drizzle-kit and apply it: 0\.4\.0 added "claims"\./;
    const logger = recordingLogger();
    const jobs = createJobs({
      db: database.current.db,
      table: altJobs,
      schedulesTable: altJobSchedules,
      logger,
    });
    const handle = jobs.define(unique("unmigrated"), { run() {} });
    const { id } = await handle.enqueue(undefined);
    await database.current.rows(sql`alter table ${altJobs} drop column claims`);
    try {
      const thrown = (fn: () => Promise<unknown>) =>
        fn().then(
          () => undefined,
          (error: unknown) => error,
        );
      for (const error of [
        await thrown(() => jobs.runOnce()),
        await thrown(() => jobs.get(id)),
        await thrown(() => jobs.list()),
      ]) {
        expect(error).toMatchObject({ code: "invalid_config" });
        expect((error as Error).message).toMatch(message);
      }
      // A worker logs it as what it is, not as an outage, and keeps going.
      const stop = new AbortController();
      const working = jobs.work({ pollInterval: "10ms", signal: stop.signal });
      await waitUntil(() => logger.lines.length > 0);
      stop.abort();
      await working;
      expect(logger.lines.map((line) => [line.level, line.message])).toEqual([
        ["error", expect.stringMatching(message)],
      ]);
    } finally {
      await database.current.rows(
        sql`alter table ${altJobs} add column claims integer not null default 0`,
      );
    }
    // Other errors are left as they are.
    await database.current.rows(sql`alter table ${altJobs} rename to alt_jobs_gone`);
    try {
      const error = await jobs.runOnce().then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toMatchObject({ code: "invalid_config" });
    } finally {
      await database.current.rows(
        sql.raw(`alter table groundwork_alt.alt_jobs_gone rename to alt_jobs`),
      );
    }
  });

  test("a running job that gave up its key and then lost its worker never runs again", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("superseded-gone");
    const seen: number[] = [];
    const releases: (() => void)[] = [];
    const victim = jobsOn(database.current, { clock, workerId: "victim", lease: "30s" });
    victim.define(type, {
      timeout: false,
      run: (payload: { n: number }) =>
        new Promise<void>((resolve) => {
          seen.push(payload.n);
          releases.push(resolve);
        }),
    });
    const handle = jobsOn(database.current, { clock }).define(type, {
      run(_payload: { n: number }) {},
    });
    await handle.enqueue({ n: 1 }, { dedupeKey: "k", replace: true });
    const victimRun = victim.runOnce({ budgetMs: 50 });
    await waitUntil(() => seen.length === 1);
    // The key goes to a new job while the first is alive; then the first's worker stalls.
    expect((await handle.enqueue({ n: 2 }, { dedupeKey: "k", replace: true })).created).toBe(true);
    clock.advance("31s");

    const rescuer = jobsOn(database.current, { clock, workerId: "rescuer", lease: "30s" });
    rescuer.define(type, {
      run(payload: { n: number }) {
        seen.push(payload.n);
      },
    });
    await rescuer.runOnce();
    expect(seen).toEqual([1, 2]);
    expect(byPayload(await rowsOfType(type)).map((row) => [row.payload, row.status])).toEqual([
      [{ n: 1 }, "failed"],
      [{ n: 2 }, "completed"],
    ]);
    for (const done of releases) done();
    await victimRun;
  }, 30_000);
});
