import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { isGroundworkError } from "../../src/internal/errors.ts";
import type { StandardSchemaV1 } from "../../src/jobs/index.ts";
import { createJobs } from "../../src/jobs/index.ts";
import { jobSchedules, jobs as jobsTable } from "../fixtures/schema.ts";
import { useTestDatabase } from "../support/database.ts";
import { recordingLogger, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();

function jobsWith(logger = recordingLogger()) {
  return createJobs({
    db: database.current.db,
    table: jobsTable,
    schedulesTable: jobSchedules,
    logger,
  });
}

// A schema whose validate throws once `deployed` is set: a payload enqueued before a deploy, then
// checked by a transform (new Date(x).toISOString()) that the new release added.
let deployed = false;
const throwingSchema: StandardSchemaV1<unknown, { at: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value) {
      const at = (value as { at: string }).at;
      return { value: { at: deployed ? new Date(at).toISOString() : at } };
    },
  },
};

describe("job runtime", () => {
  test("runOnce takes a budget duration, and says so when it gets 0.x's budgetMs", async () => {
    const jobs = jobsWith();
    expect(await jobs.runOnce({ budget: "200ms" })).toMatchObject({ claimed: 0 });
    for (const options of [{ budget: "0s" }, { budget: 200 }, { budgetMs: 200 }]) {
      const error = await Promise.resolve()
        .then(() => jobs.runOnce(options as never))
        .catch((thrown: unknown) => thrown);
      expect(isGroundworkError(error) && error.code).toBe("invalid_argument");
    }
  });

  test("a schema that throws fails the job at once with its real error, and the rest still run", async () => {
    const jobs = jobsWith();
    let ran = 0;
    const type = unique("schema.throws");
    const good = unique("schema.ok");
    const broken = jobs.define(type, { schema: throwingSchema, maxAttempts: 5, run() {} });
    const fine = jobs.define(good, {
      run() {
        ran++;
      },
    });
    const bad = await broken.enqueue({ at: "not a date" });
    for (let i = 0; i < 6; i++) await fine.enqueue({});
    deployed = true;

    const summary = await jobs.runOnce({ concurrency: 1 });
    expect(summary).toMatchObject({ completed: 6, failed: 1, retried: 0 });
    expect(ran).toBe(6);
    const record = await jobs.get(bad.id);
    expect(record).toMatchObject({ status: "failed", attempts: 1 });
    expect(record?.lastError).toContain("RangeError");
  });

  test("an idle worker doesn't pile up reactions on a long-running job", async () => {
    const jobs = jobsWith();
    const type = unique("long.job");
    let release = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handle = jobs.define(type, {
      timeout: false,
      async run() {
        started();
        await done;
      },
    });
    await handle.enqueue({});

    // Counts .then calls per promise while the worker polls every 10ms.
    const calls = new WeakMap<object, number>();
    let most = 0;
    const original = Promise.prototype.then;
    // biome-ignore lint/suspicious/noThenProperty: the test counts reactions by wrapping then.
    Promise.prototype.then = function (this: Promise<unknown>, onFulfilled, onRejected) {
      const count = (calls.get(this) ?? 0) + 1;
      calls.set(this, count);
      most = Math.max(most, count);
      return original.call(this, onFulfilled, onRejected);
    } as typeof original;
    const controller = new AbortController();
    try {
      const working = jobs.work({
        pollInterval: "10ms",
        concurrency: 2,
        signal: controller.signal,
      });
      await running;
      most = 0;
      await new Promise((resolve) => setTimeout(resolve, 500));
      // About 50 polls happened; before the fix, each one added a reaction to the job's promise.
      expect(most).toBeLessThan(10);
      release();
      controller.abort();
      await working;
    } finally {
      // biome-ignore lint/suspicious/noThenProperty: puts the real then back.
      Promise.prototype.then = original;
      release();
      controller.abort();
    }
    const rows = await database.current.rows<{ status: string }>(
      sql`select status from ${jobsTable} where type = ${type}`,
    );
    expect(rows).toEqual([{ status: "completed" }]);
  });
});
