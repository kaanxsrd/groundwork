import { describe, expect, test } from "bun:test";
import {
  type Duration,
  isDuration,
  MAX_TIMER_MS,
  parseDuration,
} from "../../src/internal/duration.ts";
import { GroundworkError } from "../../src/internal/errors.ts";

describe("parseDuration", () => {
  test.each([
    ["1ms", 1],
    ["500ms", 500],
    ["1s", 1_000],
    ["30s", 30_000],
    ["15m", 900_000],
    ["1h", 3_600_000],
    ["24h", 86_400_000],
    ["90d", 7_776_000_000],
    ["365d", 31_536_000_000],
    ["2w", 1_209_600_000],
    ["1.5s", 1_500],
    ["0.5h", 1_800_000],
    ["0s", 0],
  ] as const)("%s is %d ms", (input, ms) => {
    expect(parseDuration(input)).toBe(ms);
  });

  test("rounds fractional milliseconds to the nearest whole one", () => {
    expect(parseDuration("1.4ms")).toBe(1);
    expect(parseDuration("1.5ms")).toBe(2);
  });

  test.each([
    "",
    "15",
    "m",
    "15 m",
    " 15m",
    "15m ",
    "15M",
    "-1s",
    "+1s",
    "1e3s",
    "1.s",
    ".5s",
    "0x10s",
    "15min",
    "1y",
    "1mo",
    "1h30m",
    "Infinitys",
    "NaNs",
  ])("rejects %p", (input) => {
    expect(() => parseDuration(input as Duration)).toThrow(GroundworkError);
  });

  test("rejects values that are not strings at runtime", () => {
    for (const input of [15, null, undefined, {}, ["15m"]]) {
      expect(() => parseDuration(input as unknown as Duration)).toThrow(/Invalid duration/);
    }
  });

  test("rejects values too large to represent exactly", () => {
    expect(() => parseDuration("99999999999999w")).toThrow(/too large/);
  });

  test("enforces minMs", () => {
    expect(parseDuration("1s", { minMs: 1_000 })).toBe(1_000);
    expect(() => parseDuration("999ms", { minMs: 1_000 })).toThrow(/at least 1000ms/);
    expect(() => parseDuration("0s", { label: "window", minMs: 1 })).toThrow(/Invalid window "0s"/);
  });

  test("uses the label and code in errors", () => {
    try {
      parseDuration("soon" as Duration, { label: "window" });
      throw new Error("expected parseDuration to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GroundworkError);
      expect((error as GroundworkError).code).toBe("invalid_argument");
      expect((error as GroundworkError).message).toContain('Invalid window "soon"');
    }
  });
});

describe("durations that drive a timer", () => {
  test("stop at the longest a timer can wait", () => {
    expect(parseDuration("24d", { maxMs: MAX_TIMER_MS })).toBe(2_073_600_000);
    expect(() => parseDuration("25d", { label: "timeout", maxMs: MAX_TIMER_MS })).toThrow(
      /timeout "25d": it can be at most 24 days/,
    );
    expect(() => parseDuration("2s", { maxMs: 1_000 })).toThrow(/at most 1000ms/);
  });

  test("are checked where they're configured, not at the first timer", async () => {
    const { createJobs } = await import("../../src/jobs/index.ts");
    const { createIdempotency } = await import("../../src/idempotency/index.ts");
    const { createRateLimiter, memoryStore } = await import("../../src/rate-limit/index.ts");
    const { groundworkTables } = await import("../../src/schema/index.ts");
    const tables = groundworkTables();
    const db = { execute: async () => [] };
    const jobs = createJobs({ db, table: tables.jobs, schedulesTable: tables.jobSchedules });
    // A 30-day timeout used to fire after 1ms, failing every attempt at once.
    expect(() => jobs.define("report.monthly", { timeout: "30d", run: () => {} })).toThrow(
      /at most 24 days/,
    );
    expect(() =>
      createJobs({ db, table: tables.jobs, schedulesTable: tables.jobSchedules, lease: "30d" }),
    ).toThrow(/at most 24 days/);
    expect(() => jobs.work({ pollInterval: "30d" })).toThrow(/at most 24 days/);
    expect(() =>
      createIdempotency({
        db,
        table: tables.idempotencyKeys,
        secret: "x".repeat(32),
        lease: "30d",
      }),
    ).toThrow(/at most 24 days/);
    expect(() =>
      createRateLimiter({ store: memoryStore(), secret: "x".repeat(32), timeout: "30d" }),
    ).toThrow(/at most 24 days/);
  });
});

describe("isDuration", () => {
  test("accepts well-formed durations only", () => {
    expect(isDuration("15m")).toBe(true);
    expect(isDuration("1.5h")).toBe(true);
    expect(isDuration("15")).toBe(false);
    expect(isDuration(15)).toBe(false);
    expect(isDuration(null)).toBe(false);
  });
});

describe("Duration type", () => {
  test("rejects strings without a unit at compile time", () => {
    const ok: Duration = "15m";
    const days = 90;
    const built: Duration = `${days}d`;
    // @ts-expect-error a unit is required
    const bad: Duration = "15";
    // @ts-expect-error months are not a unit
    const months: Duration = "1mo";
    expect([ok, built, bad, months]).toHaveLength(4);
  });
});
