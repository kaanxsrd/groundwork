import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createGroundwork } from "../../src/index.ts";
import { createJobs, type JobsOptions } from "../../src/jobs/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { jobSchedules, jobs as jobsTable, rateLimits } from "../fixtures/schema.ts";
import { createTestDatabase, type TestDatabase, useTestDatabase } from "../support/database.ts";
import { recordingLogger, TEST_SECRET, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();

function jobsOn(target: Pick<TestDatabase, "db">, extra: Partial<JobsOptions> = {}) {
  return createJobs({
    db: target.db,
    table: jobsTable,
    schedulesTable: jobSchedules,
    logger: recordingLogger(),
    ...extra,
  });
}

async function rowsOfType(target: TestDatabase, type: string) {
  return target.rows<{
    status: string;
    attempts: number;
    locked_by: string | null;
    result: unknown;
    last_error: string | null;
  }>(
    sql`select status, attempts, locked_by, result, last_error from ${jobsTable} where type = ${type} order by created_at`,
  );
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("must-pass", () => {
  test("8 workers and 500 jobs: every job completes exactly once", async () => {
    const own = await createTestDatabase();
    try {
      const type = unique("race");
      const runs = new Map<number, number>();
      const byWorker = new Map<string, number>();
      const workers = Array.from({ length: 8 }, (_, i) => {
        const instance = jobsOn(own.connect({ max: 5 }), { workerId: `worker-${i}` });
        instance.define(type, {
          async run(payload: { n: number }) {
            runs.set(payload.n, (runs.get(payload.n) ?? 0) + 1);
            byWorker.set(`worker-${i}`, (byWorker.get(`worker-${i}`) ?? 0) + 1);
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 4));
          },
        });
        return instance;
      });
      const producer = jobsOn(own).define(type, { run(_payload: { n: number }) {} });
      await Promise.all(Array.from({ length: 500 }, (_, n) => producer.enqueue({ n })));

      const stop = new AbortController();
      const working = workers.map((w) =>
        w.work({ concurrency: 4, pollInterval: "20ms", signal: stop.signal }),
      );
      await waitUntil(async () => {
        const [row] = await own.rows<{ done: number }>(
          sql`select count(*)::int as done from ${jobsTable} where type = ${type} and status = 'completed'`,
        );
        return row?.done === 500;
      }, 60_000);
      stop.abort();
      const summaries = await Promise.all(working);

      expect(runs.size).toBe(500);
      expect([...runs.values()].every((count) => count === 1)).toBe(true);
      expect(summaries.reduce((sum, s) => sum + s.completed, 0)).toBe(500);
      const rows = await rowsOfType(own, type);
      expect(
        rows.every((r) => r.status === "completed" && r.attempts === 1 && r.locked_by === null),
      ).toBe(true);
      // The work really was shared: no single worker did it all.
      expect(byWorker.size).toBeGreaterThanOrEqual(4);
    } finally {
      await own.close();
    }
  }, 90_000);

  test("a killed worker's jobs are recovered after its lease ends, and its late results are ignored", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("crash");
    const releases: (() => void)[] = [];
    const victim = jobsOn(database.current, { clock, workerId: "victim", lease: "1m" });
    victim.define(type, {
      timeout: false,
      run: () => new Promise<string>((resolve) => releases.push(() => resolve("victim"))),
    });
    // Enqueued on the same fake clock as the workers, so the jobs are due for them.
    const handle = jobsOn(database.current, { clock }).define(type, { run() {} });
    await Promise.all([1, 2, 3].map(() => handle.enqueue({})));

    // The victim claims all three and then hangs, as if the process froze or was killed.
    const victimRun = victim.runOnce({ concurrency: 3, budgetMs: 50 });
    await waitUntil(async () =>
      (await rowsOfType(database.current, type)).every((r) => r.locked_by === "victim"),
    );

    const rescuer = jobsOn(database.current, { clock, workerId: "rescuer" });
    rescuer.define(type, { run: () => "rescued" });
    expect((await rescuer.runOnce()).claimed).toBe(0); // the lease still holds
    clock.advance("61s");
    expect(await rescuer.runOnce()).toMatchObject({ claimed: 3, completed: 3 });

    // The victim wakes up and finishes. Its attempt is no longer the latest, so nothing changes.
    for (const release of releases) release();
    expect(await victimRun).toMatchObject({ claimed: 3, completed: 0 });
    const rows = await rowsOfType(database.current, type);
    expect(rows.map((r) => [r.status, r.attempts, r.result])).toEqual([
      ["completed", 2, "rescued"],
      ["completed", 2, "rescued"],
      ["completed", 2, "rescued"],
    ]);
  }, 30_000);

  test("a job enqueued in a rolled-back transaction never runs", async () => {
    const { db } = database.current;
    const type = unique("tx");
    const jobs = jobsOn(database.current);
    let ran = 0;
    const handle = jobs.define(type, {
      run() {
        ran++;
      },
    });
    const rollback = new Error("roll back");
    await expect(
      db.transaction(async (tx) => {
        await handle.enqueue({ order: 1 }, { tx });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await jobs.runOnce()).claimed).toBe(0);
    expect(ran).toBe(0);
    expect(await rowsOfType(database.current, type)).toHaveLength(0);

    await db.transaction(async (tx) => {
      await handle.enqueue({ order: 2 }, { tx });
    });
    expect((await jobs.runOnce()).completed).toBe(1);
    expect(ran).toBe(1);
  });

  test("dedupeKey blocks duplicates while a job is pending or running", async () => {
    const type = unique("dedupe");
    const jobs = jobsOn(database.current);
    const handle = jobs.define(type, { run() {} });

    const first = await handle.enqueue({}, { dedupeKey: "receipt:o1" });
    const again = await handle.enqueue({}, { dedupeKey: "receipt:o1" });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: first.id, created: false });
    expect((await handle.enqueue({}, { dedupeKey: "receipt:o2" })).created).toBe(true);

    // Concurrent duplicates: exactly one is created, and every caller gets its id.
    const racers = await Promise.all(
      Array.from({ length: 20 }, () => handle.enqueue({}, { dedupeKey: "receipt:o3" })),
    );
    expect(racers.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(racers.map((r) => r.id)).size).toBe(1);

    // Once the job has finished, the key is free again.
    await jobs.runOnce();
    expect((await handle.enqueue({}, { dedupeKey: "receipt:o1" })).created).toBe(true);
    const [row] = await database.current.rows<{ n: number }>(
      sql`select count(*)::int as n from ${jobsTable} where type = ${type} and dedupe_key = 'receipt:o1'`,
    );
    expect(row?.n).toBe(2);
  });

  test("two instances never run the same schedule tick", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const name = unique("tick");
    const runs: string[] = [];
    const instances = Array.from({ length: 3 }, (_, i) => {
      const instance = jobsOn(database.current.connect({ max: 3 }), {
        clock,
        workerId: `instance-${i}`,
      });
      instance.schedule(name, { every: "1m" }, (context) => {
        runs.push(context.scheduledAt.toISOString());
        return { ticks: runs.length };
      });
      return instance;
    });
    for (let tick = 0; tick < 10; tick++) {
      await Promise.all(instances.map((instance) => instance.runOnce()));
      clock.advance("1m");
    }
    expect(runs).toHaveLength(10);
    expect(new Set(runs).size).toBe(10);
    expect(runs[0]).toBe("2026-04-01T00:00:00.000Z");
    expect(runs[9]).toBe("2026-04-01T00:09:00.000Z");
  }, 30_000);

  describe("timing", () => {
    const T0 = Date.parse("2026-04-01T00:00:00Z");
    /** Runs a "1m" (or other) schedule at each time, and returns when each tick ran. */
    async function ticksAt(every: "1m" | "10s", offsetsMs: readonly number[]) {
      const clock = createTestClock(new Date(T0).toISOString());
      const jobs = jobsOn(database.current, { clock });
      const name = unique("grid");
      const ran: number[] = [];
      jobs.schedule(name, { every }, ({ scheduledAt }) => {
        ran.push(scheduledAt.getTime() - T0);
      });
      for (const offset of offsetsMs) {
        clock.set(T0 + offset);
        await jobs.runOnce();
      }
      const schedule = (await jobs.health()).schedules.find((s) => s.name === name);
      return { ran, nextRunAt: (schedule?.nextRunAt.getTime() ?? 0) - T0 };
    }

    test("a cron that calls a moment early still runs every tick", async () => {
      // A 1-minute cron, each call a few hundred ms off its minute.
      const jitter = [0, -300, 200, -150, 400, -50, 0, -400, 100, -250, 300];
      const { ran, nextRunAt } = await ticksAt(
        "1m",
        jitter.map((ms, minute) => minute * 60_000 + ms),
      );
      expect(ran).toHaveLength(11);
      // The grid doesn't drift: the next slot is minute 11, whatever the calls' lag.
      expect(nextRunAt).toBe(11 * 60_000);
    });

    test("a tick runs at most min(every / 10, 5s) early", async () => {
      const minute = await ticksAt("1m", [0, 54_999, 55_000]);
      expect(minute.ran).toEqual([0, 55_000]); // 5s early at most
      expect(minute.nextRunAt).toBe(120_000);
      const short = await ticksAt("10s", [0, 8_999, 9_000]);
      expect(short.ran).toEqual([0, 9_000]); // a tenth of 10s
      expect(short.nextRunAt).toBe(20_000);
    });

    test("missed slots aren't replayed; the grid restarts from now", async () => {
      const { ran, nextRunAt } = await ticksAt("1m", [0, 10 * 60_000 + 1_000, 10 * 60_000 + 2_000]);
      expect(ran).toEqual([0, 601_000]); // one tick for the outage, not ten
      expect(nextRunAt).toBe(661_000);
    });
  });

  test("a schedule's runs are listed by its name", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const jobs = jobsOn(database.current, { clock });
    const [a, b] = [unique("listed"), unique("other")];
    jobs.schedule(a, { every: "1m" }, () => ({ ok: true }));
    jobs.schedule(b, { every: "1m" }, () => ({ ok: true }));
    const handle = jobs.define(unique("plain"), { run: () => {} });
    await handle.enqueue({});
    await jobs.runOnce();
    await jobs.trigger(a);
    await jobs.runOnce();

    const runs = await jobs.list({ schedule: a });
    expect(runs.map((run) => [run.schedule, run.type, run.status])).toEqual([
      [a, `schedule:${a}`, "completed"],
      [a, `schedule:${a}`, "completed"],
    ]);
    expect(await jobs.list({ schedule: [a, b], limit: 10 })).toHaveLength(3);
    expect((await jobs.list({ type: handle.type }))[0]?.schedule).toBeNull();
    expect(await jobs.list({ schedule: [] })).toEqual([]);
  });
});

describe("retries", () => {
  test("a backoff ladder waits each step exactly, then repeats the last", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("ladder");
    // random 0 would make a jittered wait 0, so any wait here comes from the ladder.
    const jobs = jobsOn(database.current, { clock, random: () => 0 });
    const handle = jobs.define(type, {
      maxAttempts: 4,
      backoff: { delays: ["10s", "1m"] },
      run(_payload: unknown, context) {
        if (context.attempt < 4) throw new Error(`down ${context.attempt}`);
        return { sent: true };
      },
    });
    const { id } = await handle.enqueue({});
    const runAts: string[] = [];
    for (const wait of ["10s", "1m", "1m"] as const) {
      expect(await jobs.runOnce()).toMatchObject({ retried: 1 });
      runAts.push((await jobs.get(id))?.runAt.toISOString() ?? "");
      clock.advance(wait);
    }
    expect(runAts).toEqual([
      "2026-04-01T00:00:10.000Z",
      "2026-04-01T00:01:10.000Z",
      "2026-04-01T00:02:10.000Z",
    ]);
    expect(await jobs.runOnce()).toMatchObject({ completed: 1 });
    expect(await jobs.get(id)).toMatchObject({ status: "completed", attempts: 4 });
  });

  test("a failing job is retried with jittered backoff, then succeeds", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("flaky");
    const attempts: number[] = [];
    const jobs = jobsOn(database.current, { clock, random: () => 1 }); // the longest wait, so it's predictable
    const handle = jobs.define(type, {
      backoff: { base: "10s", max: "1m" },
      run(_payload: unknown, context) {
        attempts.push(context.attempt);
        if (context.attempt < 3) throw new Error(`flaky ${context.attempt}`);
        return { ok: true };
      },
    });
    const { id } = await handle.enqueue({});
    expect(await jobs.runOnce()).toMatchObject({ claimed: 1, retried: 1 });
    let job = await jobs.get(id);
    expect(job).toMatchObject({ status: "pending", attempts: 1, lastError: "Error: flaky 1" });
    expect(job?.runAt.toISOString()).toBe("2026-04-01T00:00:10.000Z");

    clock.advance("9s");
    expect((await jobs.runOnce()).claimed).toBe(0); // not due yet
    clock.advance("1s");
    expect(await jobs.runOnce()).toMatchObject({ retried: 1 });
    job = await jobs.get(id);
    expect(job?.runAt.toISOString()).toBe("2026-04-01T00:00:30.000Z"); // 10s * 2

    clock.advance("20s");
    expect(await jobs.runOnce()).toMatchObject({ completed: 1 });
    expect(await jobs.get(id)).toMatchObject({
      status: "completed",
      attempts: 3,
      lastError: null,
      result: { ok: true },
    });
    expect(attempts).toEqual([1, 2, 3]);
  });

  test("after the last attempt the job fails for good and onExhausted runs once", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("doomed");
    const exhausted: unknown[] = [];
    const logger = recordingLogger();
    const jobs = jobsOn(database.current, { clock, random: () => 0, logger });
    const handle = jobs.define(type, {
      maxAttempts: 2,
      run(_payload: { notificationId: string }) {
        throw new Error("smtp down");
      },
      onExhausted(payload, failure, context) {
        exhausted.push({ payload, failure, attempt: context.attempt });
      },
    });
    const { id } = await handle.enqueue({ notificationId: "n1" });
    await jobs.runOnce();
    await jobs.runOnce(); // backoff 0 with random() = 0
    expect(await jobs.get(id)).toMatchObject({
      status: "failed",
      attempts: 2,
      lastError: "Error: smtp down",
    });
    expect((await jobs.get(id))?.completedAt).toBeInstanceOf(Date);
    expect(exhausted).toEqual([
      {
        payload: { notificationId: "n1" },
        failure: { name: "Error", message: "smtp down", attempt: 2 },
        attempt: 2,
      },
    ]);
    expect(logger.lines.map((l) => l.level)).toEqual(["warn", "error"]);
    expect(JSON.stringify(logger.lines)).not.toContain("n1"); // payloads are never logged
    expect((await jobs.runOnce()).claimed).toBe(0);
  });

  test("a job whose worker died on its last attempt fails instead of running again", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("lastchance");
    const hung = jobsOn(database.current, { clock, workerId: "hung" });
    hung.define(type, { timeout: false, maxAttempts: 1, run: () => new Promise(() => {}) });
    const handle = jobsOn(database.current, { clock }).define(type, { maxAttempts: 1, run() {} });
    const { id } = await handle.enqueue({});
    void hung.runOnce({ budgetMs: 50 });
    await waitUntil(async () => (await jobsOn(database.current).get(id))?.status === "running");
    clock.advance("61s");
    let exhausted = 0;
    const rescuer = jobsOn(database.current, { clock, workerId: "rescuer" });
    rescuer.define(type, {
      maxAttempts: 1,
      run: () => "should not run",
      onExhausted() {
        exhausted++;
      },
    });
    expect(await rescuer.runOnce()).toMatchObject({ claimed: 1, failed: 1, completed: 0 });
    expect(await rescuer.get(id)).toMatchObject({
      status: "failed",
      lastError: "Error: The worker running the last attempt stopped before finishing.",
    });
    expect(exhausted).toBe(1);
  }, 30_000);

  test("a timeout aborts the handler's signal and counts as a failure", async () => {
    const type = unique("slow");
    const jobs = jobsOn(database.current);
    let sawAbort = false;
    const handle = jobs.define(type, {
      timeout: "50ms",
      maxAttempts: 1,
      run(_payload: unknown, { signal }) {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            resolve("too late");
          });
        });
      },
    });
    const { id } = await handle.enqueue({});
    expect(await jobs.runOnce()).toMatchObject({ failed: 1 });
    expect(sawAbort).toBe(true);
    expect((await jobs.get(id))?.lastError).toBe("TimeoutError: Timed out after 50ms.");
  });

  test("the lease is renewed while a long job runs, so no one else picks it up", async () => {
    const own = await createTestDatabase();
    try {
      const type = unique("long");
      let runs = 0;
      const make = (workerId: string) => {
        const instance = jobsOn(own.connect({ max: 2 }), { workerId, lease: "3s" });
        instance.define(type, {
          timeout: false,
          async run() {
            runs++;
            await new Promise((resolve) => setTimeout(resolve, 4_500)); // longer than the lease
          },
        });
        return instance;
      };
      const first = make("first");
      const second = make("second");
      await jobsOn(own)
        .define(type, { run() {} })
        .enqueue({});
      const running = first.runOnce();
      await waitUntil(async () => (await rowsOfType(own, type))[0]?.status === "running");
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        expect((await second.runOnce()).claimed).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(await running).toMatchObject({ completed: 1 });
      expect(runs).toBe(1);
    } finally {
      await own.close();
    }
  }, 20_000);
});

describe("enqueueing", () => {
  test("schemas validate on enqueue and again before running, with the schema's output", async () => {
    const type = unique("schema");
    const jobs = jobsOn(database.current);
    const seen: unknown[] = [];
    const handle = jobs.define(type, {
      maxAttempts: 3,
      schema: z.object({ orderId: z.string(), copies: z.number().default(1) }),
      run(payload) {
        seen.push(payload);
      },
    });
    await expect(handle.enqueue({ orderId: 42 } as never)).rejects.toThrow(/Invalid payload/);
    await handle.enqueue({ orderId: "o1" });
    // A row written by something else that doesn't match the schema never will: no retries.
    await database.current.db.execute(
      sql`insert into ${jobsTable} (type, payload, max_attempts) values (${type}, '{"orderId": 7}', 3)`,
    );
    expect(await jobs.runOnce()).toMatchObject({ completed: 1, failed: 1, retried: 0 });
    expect(seen).toEqual([{ orderId: "o1", copies: 1 }]);
    const failed = await jobs.list({ type, status: "failed" });
    expect(failed[0]?.lastError).toContain("Invalid payload: orderId:");
  });

  test("higher priority runs first; delayed and future jobs wait", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("order");
    const order: string[] = [];
    const jobs = jobsOn(database.current, { clock });
    const handle = jobs.define(type, {
      run(payload: { name: string }) {
        order.push(payload.name);
      },
    });
    await handle.enqueue({ name: "low" });
    await handle.enqueue({ name: "high" }, { priority: 10 });
    await handle.enqueue({ name: "later" }, { delay: "5m" });
    await handle.enqueue({ name: "tomorrow" }, { runAt: new Date("2026-04-02T00:00:00Z") });
    await jobs.runOnce({ concurrency: 1 });
    expect(order).toEqual(["high", "low"]);
    clock.advance("5m");
    await jobs.runOnce();
    clock.set("2026-04-02T00:00:00Z");
    await jobs.runOnce();
    expect(order).toEqual(["high", "low", "later", "tomorrow"]);
  });

  test("payloads are stored as JSON", async () => {
    const type = unique("json");
    const jobs = jobsOn(database.current);
    const handle = jobs.define(type, {
      run(payload: unknown) {
        return payload;
      },
    });
    const { id } = await handle.enqueue({
      at: new Date("2026-01-01T00:00:00Z"),
      big: 10n,
      skip: undefined,
    });
    expect((await jobs.get(id))?.payload).toEqual({ at: "2026-01-01T00:00:00.000Z", big: "10" });
  });
});

describe("workers", () => {
  test("work() stops claiming on abort and resolves after running jobs finish", async () => {
    const type = unique("graceful");
    const jobs = jobsOn(database.current);
    let started = 0;
    let finished = 0;
    const handle = jobs.define(type, {
      async run() {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 300));
        finished++;
      },
    });
    await handle.enqueue({});
    const stop = new AbortController();
    const working = jobs.work({ concurrency: 2, pollInterval: "20ms", signal: stop.signal });
    await waitUntil(async () => started === 1);
    stop.abort();
    await handle.enqueue({}); // too late: the worker is stopping
    const summary = await working;
    expect(summary).toMatchObject({ claimed: 1, completed: 1 });
    expect(finished).toBe(1);
    expect((await jobs.list({ type, status: "pending" })).length).toBe(1);
  });

  test("runOnce stops claiming when its budget runs out", async () => {
    const type = unique("budget");
    const jobs = jobsOn(database.current);
    const handle = jobs.define(type, {
      run: () => new Promise((resolve) => setTimeout(resolve, 100)),
    });
    await Promise.all(Array.from({ length: 10 }, () => handle.enqueue({})));
    const summary = await jobs.runOnce({ budgetMs: 150, concurrency: 1 });
    expect(summary.completed).toBeGreaterThanOrEqual(1);
    expect(summary.completed).toBeLessThan(10);
    expect(summary.claimed).toBe(summary.completed);
  });

  test("jobs of a type this worker doesn't know are left alone", async () => {
    const type = unique("unknown");
    await database.current.db.execute(sql`insert into ${jobsTable} (type) values (${type})`);
    const jobs = jobsOn(database.current);
    jobs.define(unique("other"), { run() {} });
    expect((await jobs.runOnce()).claimed).toBe(0);
    const health = await jobs.health();
    expect(health.types.find((t) => t.type === type)).toMatchObject({ pending: 1, running: 0 });
  });
});

describe("operations", () => {
  test("get, list, retry, cancel and prune", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const type = unique("ops");
    const jobs = jobsOn(database.current, { clock });
    let fail = true;
    const handle = jobs.define(type, {
      maxAttempts: 1,
      run() {
        if (fail) throw new Error("nope");
      },
    });
    const failing = await handle.enqueue({ n: 1 });
    const pending = await handle.enqueue({ n: 2 }, { delay: "1h" });
    await jobs.runOnce();
    expect(await jobs.get(failing.id)).toMatchObject({ status: "failed" });

    expect(await jobs.cancel(pending.id)).toBe(true);
    expect(await jobs.cancel(pending.id)).toBe(false);
    expect(await jobs.cancel(failing.id)).toBe(false); // only pending jobs

    fail = false;
    expect(await jobs.retry(failing.id)).toBe(true);
    expect(await jobs.get(failing.id)).toMatchObject({ status: "pending", attempts: 0 });
    await jobs.runOnce();
    expect(await jobs.get(failing.id)).toMatchObject({ status: "completed", attempts: 1 });
    expect(await jobs.retry(failing.id)).toBe(false); // completed jobs aren't retried

    expect((await jobs.list({ type })).map((j) => j.status).sort()).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(await jobs.list({ type, status: ["completed"] })).toHaveLength(1);
    expect(await jobs.list({ type, since: new Date("2030-01-01") })).toHaveLength(0);
    expect(await jobs.get("not-a-uuid")).toBeNull();

    clock.advance("8d");
    const deleted = await jobs.prune({ completedOlderThan: "7d" });
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await jobs.list({ type })).toHaveLength(0);
  });

  test("health reports queues and schedules", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const own = await createTestDatabase();
    try {
      const jobs = jobsOn(own, { clock, random: () => 0 });
      const ok = jobs.define("mail.send", { run() {} });
      const bad = jobs.define("mail.bounce", {
        maxAttempts: 1,
        run() {
          throw new Error("x");
        },
      });
      let scheduleFails = false;
      jobs.schedule("reports.daily", { every: "1h" }, () => {
        if (scheduleFails) throw new Error("report failed");
        return { rows: 3 };
      });
      await ok.enqueue({});
      await bad.enqueue({});
      await jobs.runOnce();
      await ok.enqueue({});
      clock.advance("10m");

      const health = await jobs.health();
      expect(health.types.find((t) => t.type === "mail.send")).toMatchObject({
        pending: 1,
        running: 0,
        failedLast24h: 0,
        oldestPendingAgeMs: 600_000,
        lastSuccessAt: new Date("2026-04-01T00:00:00Z"),
      });
      expect(health.types.find((t) => t.type === "mail.bounce")).toMatchObject({
        failedLast24h: 1,
        lastSuccessAt: null,
      });
      expect(health.schedules).toEqual([
        {
          name: "reports.daily",
          every: "1h",
          nextRunAt: new Date("2026-04-01T01:00:00Z"),
          lastRunAt: new Date("2026-04-01T00:00:00Z"),
          lastSuccessAt: new Date("2026-04-01T00:00:00Z"),
          lastFailureAt: null,
          lastError: null,
          healthy: true,
        },
      ]);
      expect((await jobs.list({ type: "schedule:reports.daily" }))[0]?.result).toEqual({ rows: 3 });

      // trigger() makes it due now; a failure shows up in health.
      scheduleFails = true;
      expect(await jobs.trigger("reports.daily")).toBe(true);
      expect(await jobs.trigger("nope")).toBe(false);
      await jobs.runOnce();
      await jobs.runOnce();
      await jobs.runOnce(); // three attempts with no backoff (random() = 0)
      const after = (await jobs.health()).schedules[0];
      expect(after?.lastError).toBe("Error: report failed");
      expect(after?.lastFailureAt).toEqual(new Date("2026-04-01T00:10:00Z"));
      clock.advance("3h");
      expect((await jobs.health()).schedules[0]?.healthy).toBe(false); // no success in 3 intervals
    } finally {
      await own.close();
    }
  });

  test("a schedule tick is skipped while the previous one is still running", async () => {
    const clock = createTestClock("2026-04-01T00:00:00Z");
    const name = unique("overlap");
    let release!: () => void;
    let runs = 0;
    // The lease outlasts the tick, so the first run is still owned when the next tick comes.
    const jobs = jobsOn(database.current, { clock, lease: "10m" });
    jobs.schedule(name, { every: "1m", timeout: false }, () => {
      runs++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const firstRun = jobs.runOnce({ budgetMs: 50 });
    await waitUntil(async () => runs === 1);
    clock.advance("1m");
    const other = jobsOn(database.current, { clock, lease: "10m" });
    other.schedule(name, { every: "1m" }, () => {
      runs++;
    });
    expect(await other.runOnce()).toMatchObject({ scheduled: 0, claimed: 0 });
    release();
    await firstRun;
    expect(runs).toBe(1);
  });
});

describe("createGroundwork", () => {
  test("gw.jobs schedules the rate-limit cleanup hourly", async () => {
    const own = await createTestDatabase();
    try {
      const clock = createTestClock("2026-04-01T00:00:00Z");
      const gw = createGroundwork({
        db: own.db,
        tables: { jobs: jobsTable, jobSchedules, rateLimits },
        secret: TEST_SECRET,
        clock,
        logger: recordingLogger(),
      });
      const rule = gw.rateLimit.rule({ name: "cleanup-test", limit: 1, window: "1m" });
      await rule.check("a");
      clock.advance("2m");
      const summary = await gw.jobs.runOnce();
      expect(summary).toMatchObject({ scheduled: 1, completed: 1 });
      const [cleanup] = await gw.jobs.list({ type: "schedule:groundwork.rate-limit-cleanup" });
      expect(cleanup?.result).toEqual({ deleted: 1 });
      expect((await gw.jobs.health()).schedules.map((s) => s.name)).toEqual([
        "groundwork.rate-limit-cleanup",
      ]);
      expect(() => createGroundwork({ db: own.db, tables: {}, secret: TEST_SECRET }).jobs).toThrow(
        /needs the jobs table/,
      );
    } finally {
      await own.close();
    }
  });
});
