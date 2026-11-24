import { describe, expect, test } from "bun:test";
import type { SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import { validateWith } from "../../src/internal/standard-schema.ts";
import { ladderDelayMs } from "../../src/jobs/backoff.ts";
import { backoffDelayMs, createJobs, type JobHandle } from "../../src/jobs/index.ts";
import { groundworkTables } from "../../src/schema/index.ts";

const { jobs: table, jobSchedules: schedulesTable } = groundworkTables();

function recordingDb() {
  const calls: SQLWrapper[] = [];
  const execute = async (query: SQLWrapper) => {
    calls.push(query);
    return [];
  };
  return { calls, db: { execute } };
}

const quiet = { warn: () => {}, error: () => {} };

describe("backoffDelayMs", () => {
  test("is a random wait up to base * 2^(attempt - 1), capped", () => {
    expect(backoffDelayMs(1, 30_000, 3_600_000, () => 0.999_999)).toBe(29_999);
    expect(backoffDelayMs(2, 30_000, 3_600_000, () => 0.5)).toBe(30_000);
    expect(backoffDelayMs(4, 30_000, 3_600_000, () => 1)).toBe(240_000);
    expect(backoffDelayMs(20, 30_000, 3_600_000, () => 1)).toBe(3_600_000);
    expect(backoffDelayMs(3, 30_000, 3_600_000, () => 0)).toBe(0);
  });

  test("full jitter spreads retries across the whole range", () => {
    const delays = Array.from({ length: 2_000 }, () =>
      backoffDelayMs(3, 1_000, 60_000, Math.random),
    );
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...delays)).toBeLessThan(4_000);
    // Roughly uniform: both halves of the range get a fair share.
    const low = delays.filter((d) => d < 2_000).length;
    expect(low).toBeGreaterThan(800);
    expect(low).toBeLessThan(1_200);
  });
});

describe("work()", () => {
  test("an idle worker doesn't pile up abort listeners on its signal", async () => {
    const { getEventListeners } = await import("node:events");
    const jobs = createJobs({ db: recordingDb().db, table, schedulesTable, logger: quiet });
    jobs.define("idle.job", { run: () => {} });
    const stop = new AbortController();
    const worker = jobs.work({ signal: stop.signal, pollInterval: "10ms" });
    await new Promise((resolve) => setTimeout(resolve, 200)); // about 20 idle polls
    expect(getEventListeners(stop.signal, "abort").length).toBeLessThanOrEqual(1);
    stop.abort();
    await worker;
  });
});

describe("a backoff ladder", () => {
  test("waits each step in turn, then repeats the last one", () => {
    const ladder = [30_000, 120_000, 600_000];
    expect([1, 2, 3, 4, 10].map((attempt) => ladderDelayMs(attempt, ladder))).toEqual([
      30_000, 120_000, 600_000, 600_000, 600_000,
    ]);
    expect(ladderDelayMs(0, ladder)).toBe(30_000);
  });

  test("is checked when the job type is defined", () => {
    const jobs = createJobs({ db: recordingDb().db, table, schedulesTable, logger: quiet });
    const define = (backoff: unknown) => () =>
      jobs.define(`ladder-${Math.random().toString(36).slice(2)}`, {
        backoff: backoff as never,
        run: () => {},
      });
    expect(define({ delays: ["30s", "2m"] })).not.toThrow();
    expect(define({ delays: ["30s"], base: "10s" })).toThrow(/either delays, or base and max/);
    expect(define({ delays: [] })).toThrow(/list of 1 to 100 durations/);
    expect(define({ delays: Array.from({ length: 101 }, () => "1s") })).toThrow(/1 to 100/);
    expect(define({ delays: "30s" })).toThrow(/list of 1 to 100 durations/);
    expect(define({ delays: ["30s", "soon"] })).toThrow(/backoff\.delays\[1\]/);
  });
});

describe("Standard Schema", () => {
  test("collects every issue with its path, from any library", async () => {
    const schema = z.object({ orderId: z.string(), lines: z.array(z.object({ qty: z.number() })) });
    const result = await validateWith(schema, { orderId: 5, lines: [{ qty: "x" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("orderId:");
      expect(result.message).toContain("lines.0.qty:");
    }
    expect(await validateWith(schema, { orderId: "o1", lines: [] })).toEqual({
      ok: true,
      value: { orderId: "o1", lines: [] },
    });
  });

  test("a hand-written schema works too", async () => {
    const even = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) =>
          typeof value === "number" && value % 2 === 0
            ? { value }
            : { issues: [{ message: "must be even" }] },
      },
    };
    expect(await validateWith(even, 4)).toEqual({ ok: true, value: 4 });
    expect(await validateWith(even, 3)).toEqual({ ok: false, message: "must be even" });
  });
});

describe("createJobs", () => {
  const jobsFor = () => createJobs({ ...recordingDb(), table, schedulesTable, logger: quiet });

  test("rejects bad options", () => {
    const { db } = recordingDb();
    expect(() => createJobs(undefined as never)).toThrow(/options object/);
    expect(() => createJobs({ db, table, schedulesTable: table as never })).toThrow(
      /is not the jobSchedules table/,
    );
    expect(() => createJobs({ db, table, schedulesTable, lease: "10ms" })).toThrow(/Invalid lease/);
    expect(() => createJobs({ db, table, schedulesTable, workerId: "" })).toThrow(/workerId/);
  });

  test("validates definitions", () => {
    const jobs = jobsFor();
    jobs.define("email.receipt", { run: () => {} });
    expect(() => jobs.define("email.receipt", { run: () => {} })).toThrow(/already defined/);
    expect(() => jobs.define("has space", { run: () => {} })).toThrow(/Invalid job type/);
    expect(() => jobs.define("schedule:x", { run: () => {} })).toThrow(
      /that prefix is for schedules/,
    );
    expect(() => jobs.define("x", {} as never)).toThrow(/needs a run function/);
    expect(() => jobs.define("y", { run: () => {}, maxAttempts: 0 })).toThrow(/maxAttempts/);
    expect(() => jobs.define("z", { run: () => {}, timeout: "soon" as never })).toThrow(
      /Invalid timeout/,
    );
    expect(() => jobs.define("w", { schema: {} as never, run: () => {} })).toThrow(
      /isn't a Standard Schema/,
    );
    expect(() => jobs.schedule("tick", { every: "100ms" }, () => {})).toThrow(/at least 1000ms/);
    jobs.schedule("tick", { every: "1m" }, () => {});
    expect(() => jobs.schedule("tick", { every: "1m" }, () => {})).toThrow(/already defined/);
  });

  test("checks the payload against the schema before sending anything", async () => {
    const { db, calls } = recordingDb();
    const jobs = createJobs({ db, table, schedulesTable, logger: quiet });
    const send = jobs.define("email.receipt", {
      schema: z.object({ orderId: z.string() }),
      run: () => {},
    });
    await expect(send.enqueue({ orderId: 5 } as never)).rejects.toThrow(
      /Invalid payload for job type "email.receipt": orderId:/,
    );
    await expect(
      send.enqueue({ orderId: "o1" }, { runAt: new Date(), delay: "1m" }),
    ).rejects.toThrow(/not both/);
    await expect(send.enqueue({ orderId: "o1" }, { dedupeKey: "" })).rejects.toThrow(/dedupeKey/);
    await expect(send.enqueue({ orderId: "o1" }, { priority: 1.5 })).rejects.toThrow(/priority/);
    expect(calls).toHaveLength(0);
  });

  test("payload types come from the schema, or from run's parameter", () => {
    const jobs = jobsFor();
    const withSchema = jobs.define("a", {
      schema: z.object({ orderId: z.string(), retries: z.number().default(0) }),
      run(payload) {
        // The schema's output type: the default is filled in.
        const retries: number = payload.retries;
        return retries;
      },
    });
    const annotated = jobs.define("b", {
      run(payload: { userId: number }) {
        return payload.userId;
      },
    });
    const typeOnly = (handle: JobHandle<"a", { orderId: string; retries?: number | undefined }>) =>
      handle;
    typeOnly(withSchema);
    // Type checks only; never called.
    // @ts-expect-error orderId must be a string
    const bad = () => withSchema.enqueue({ orderId: 1 });
    // @ts-expect-error userId must be a number
    const bad2 = () => annotated.enqueue({ userId: "x" });
    const good = () => annotated.enqueue({ userId: 1 }, { delay: "5m", dedupeKey: "u1" });
    expect([bad, bad2, good].every((f) => typeof f === "function")).toBe(true);
    expect(withSchema.type).toBe("a");
  });
});
