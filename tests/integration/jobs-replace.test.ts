// enqueue({ dedupeKey, replace: true }): debouncing a job, as graphile-worker's "replace" mode.
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createJobs, type JobsOptions } from "../../src/jobs/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { jobSchedules, jobs as jobsTable } from "../fixtures/schema.ts";
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
  result: unknown;
  run_at_ms: number;
}

async function rowsOfType(type: string): Promise<Row[]> {
  return database.current.rows<Row>(sql`
    select id::text as id, status, payload, dedupe_key, attempts, result,
      (extract(epoch from run_at) * 1000)::float8 as run_at_ms
    from ${jobsTable} where type = ${type} order by created_at, id`);
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
    expect((await rowsOfType(type)).map((row) => [row.status, row.payload, row.attempts])).toEqual([
      ["pending", { n: 2 }, 1],
    ]);

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
    expect((await rowsOfType(type)).map((row) => [row.status, row.attempts, row.result])).toEqual([
      ["completed", 2, "rescued 2"],
    ]);
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
});
