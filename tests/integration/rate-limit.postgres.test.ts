import { describe, expect, test } from "bun:test";
import { type SQLWrapper, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { createGroundwork } from "../../src/index.ts";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import {
  createRateLimiter,
  type RateLimitAlgorithm,
  type RuleOptions,
} from "../../src/rate-limit/index.ts";
import { storageKey } from "../../src/rate-limit/policy.ts";
import type { RateLimitsTable } from "../../src/schema/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { altRateLimits, rateLimits } from "../fixtures/schema.ts";
import {
  createTestDatabase,
  openConnection,
  testDriver,
  useTestDatabase,
} from "../support/database.ts";
import {
  rateLimitConformance,
  recordingLogger,
  T0,
  TEST_SECRET,
  unique,
} from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();
const subkey = deriveSubkey(TEST_SECRET, "rate-limit");
const keyFor = (algorithm: RateLimitAlgorithm, rule: string, subject: string) =>
  storageKey(subkey, algorithm, rule, subject);

async function storedRow(key: string, table: RateLimitsTable = rateLimits) {
  const [row] = await database.current.rows<{ used: number; rule: string }>(
    sql`select used, rule from ${table} where key = ${key}`,
  );
  return row;
}

rateLimitConformance(
  "postgres store",
  () => (clock, logger) =>
    createRateLimiter({
      db: database.current.db,
      table: rateLimits,
      secret: TEST_SECRET,
      clock,
      logger,
    }),
);

describe("postgres store: concurrency", () => {
  const ruleFor = (algorithm: RateLimitAlgorithm, name: string): RuleOptions =>
    algorithm === "fixed-window"
      ? { name, limit: 10, window: "1h" }
      : // One token an hour: nothing refills while the test runs.
        { name, algorithm, rate: 1, per: "1h", burst: 10 };

  for (const algorithm of ["fixed-window", "token-bucket"] as const) {
    test(`100 concurrent checks against a limit of 10 allow exactly 10 (${algorithm})`, async () => {
      // Four pools with a limiter each: four app instances sharing one database.
      const logger = recordingLogger();
      const name = unique("race");
      const rules = Array.from({ length: 4 }, () =>
        createRateLimiter({
          db: database.current.connect({ max: 10 }).db,
          table: rateLimits,
          secret: TEST_SECRET,
          logger,
        }).rule(ruleFor(algorithm, name)),
      );

      for (let round = 0; round < 5; round++) {
        const subject = unique("client");
        const results = await Promise.all(
          Array.from({ length: 100 }, (_, i) => rules[i % rules.length]!.check(subject)),
        );
        expect(results.filter((r) => r.allowed)).toHaveLength(10);
        expect(results.filter((r) => r.degraded !== false)).toHaveLength(0);
        // The database agrees, and the 90 denials used nothing.
        const row = await storedRow(keyFor(algorithm, name, subject));
        expect(row?.used).toBeCloseTo(10, 3);
      }
      expect(logger.lines).toEqual([]);
    }, 30_000);
  }

  test("concurrent weighted checks never overspend", async () => {
    const name = unique("weighted");
    const rules = Array.from({ length: 4 }, () =>
      createRateLimiter({
        db: database.current.connect({ max: 10 }).db,
        table: rateLimits,
        secret: TEST_SECRET,
      }).rule({ name, limit: 100, window: "1h" }),
    );
    const subject = unique("client");
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => rules[i % 4]!.check(subject, { cost: 3 })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(33);
    expect((await storedRow(keyFor("fixed-window", name, subject)))?.used).toBe(99);
  }, 30_000);
});

describe("postgres store: storage", () => {
  test("stores an HMAC of the subject, never the subject", async () => {
    const name = unique("privacy");
    const rule = createRateLimiter({
      db: database.current.db,
      table: rateLimits,
      secret: TEST_SECRET,
    }).rule({ name, limit: 5, window: "1m" });
    const subject = "203.0.113.7";
    await rule.check(subject);

    const rows = await database.current.rows<Record<string, unknown>>(
      sql`select * from ${rateLimits} where rule = ${name}`,
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(subject);
    expect(rows[0]?.key).toBe(keyFor("fixed-window", name, subject));
    expect(rows[0]?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("uses the database clock when no clock is injected", async () => {
    const rule = createRateLimiter({
      db: database.current.db,
      table: rateLimits,
      secret: TEST_SECRET,
    }).rule({ name: unique("dbclock"), limit: 5, window: "10m" });
    const before = Date.now();
    const result = await rule.check(unique("client"));
    const after = Date.now();
    // The container's clock is the host's, within a little drift.
    expect(result.resetAt.getTime()).toBeGreaterThan(before + 600_000 - 5_000);
    expect(result.resetAt.getTime()).toBeLessThan(after + 600_000 + 5_000);
  });

  test("a check is one database round trip, allowed or denied", async () => {
    let calls = 0;
    const counting = {
      execute: (query: SQLWrapper) => {
        calls++;
        return database.current.db.execute(query);
      },
    };
    const rule = createRateLimiter({ db: counting, table: rateLimits, secret: TEST_SECRET }).rule({
      name: unique("trip"),
      limit: 1,
      window: "1m",
    });
    const subject = unique("client");
    expect((await rule.check(subject)).allowed).toBe(true);
    expect(calls).toBe(1);
    const denied = await rule.check(subject);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(calls).toBe(2);
  });

  test("works with tables in their own Postgres schema and prefix", async () => {
    const name = unique("alt");
    const rule = createRateLimiter({
      db: database.current.db,
      table: altRateLimits,
      secret: TEST_SECRET,
    }).rule({ name, limit: 1, window: "1m" });
    const subject = unique("client");
    expect((await rule.check(subject)).allowed).toBe(true);
    expect((await rule.check(subject)).allowed).toBe(false);
    expect((await storedRow(keyFor("fixed-window", name, subject), altRateLimits))?.used).toBe(1);
    expect(await storedRow(keyFor("fixed-window", name, subject))).toBeUndefined();
  });

  test("rejects a table that isn't a groundwork rate-limit table", () => {
    const other = pgTable("not_rate_limits", { id: text("id").primaryKey() });
    expect(() =>
      createRateLimiter({
        db: database.current.db,
        // @ts-expect-error the wrong table is a type error too
        table: other,
        secret: TEST_SECRET,
      }),
    ).toThrow(/not a groundwork rate-limit table/);
  });
});

describe("postgres store: reset and cleanup", () => {
  test("reset joins a transaction and rolls back with it", async () => {
    const { db } = database.current;
    const rule = createRateLimiter({ db, table: rateLimits, secret: TEST_SECRET }).rule({
      name: unique("tx"),
      limit: 1,
      window: "1h",
    });
    const subject = unique("user");
    await rule.check(subject);

    const rollback = new Error("roll back");
    await expect(
      db.transaction(async (tx) => {
        await rule.reset(subject, { tx });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await rule.check(subject)).allowed).toBe(false);

    await db.transaction(async (tx) => {
      await rule.reset(subject, { tx });
    });
    expect((await rule.check(subject)).allowed).toBe(true);
  });

  test("cleanup deletes expired rows only, in batches, skipping rows that are in use", async () => {
    const own = await createTestDatabase();
    try {
      const clock = createTestClock(T0);
      const limiter = createRateLimiter({
        db: own.db,
        table: rateLimits,
        secret: TEST_SECRET,
        clock,
      });
      const live = limiter.rule({ name: "live", limit: 5, window: "1h" });
      const bucket = limiter.rule({
        name: "bucket",
        algorithm: "token-bucket",
        rate: 1,
        per: "1m",
        burst: 5,
      });
      await live.check("a");
      await bucket.check("a", { cost: 2 }); // full again 2 minutes from now

      // 12,000 rows that expired long ago: more than two cleanup batches.
      await own.db.execute(sql`
        insert into ${rateLimits} (key, rule, used, updated_at, expires_at)
        select 'old-' || n, 'old', 1, ${new Date(T0 - 7_200_000).toISOString()}::timestamptz,
               ${new Date(T0 - 3_600_000).toISOString()}::timestamptz
        from generate_series(1, 12000) n`);

      // Another session holds one expired row; cleanup must skip it instead of waiting.
      const locker = own.connect({ max: 1 });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = locker.db.transaction(async (tx) => {
        await tx.execute(sql`select key from ${rateLimits} where key = 'old-1' for update`);
        locked();
        await released;
      });
      await isLocked;

      clock.advance("3m"); // the bucket row is now expired too; the window row is not
      expect(await limiter.cleanup()).toBe(12_000); // 11,999 old rows + the bucket row
      release();
      await holding;

      const remaining = await own.rows<{ key: string; rule: string }>(
        sql`select key, rule from ${rateLimits} order by rule`,
      );
      expect(remaining.map((r) => r.rule)).toEqual(["live", "old"]);
      expect(await limiter.cleanup()).toBe(1); // the row that was locked
    } finally {
      await own.close();
    }
  }, 30_000);
});

describe("postgres store: failure modes", () => {
  const unreachable = () =>
    openConnection("postgres://groundwork:groundwork@127.0.0.1:1/nothing", testDriver(), 1);

  test("falls back to memory when the database is down, and logs it once", async () => {
    const down = unreachable();
    try {
      const clock = createTestClock(T0);
      const logger = recordingLogger();
      const rule = createRateLimiter({
        db: down.db,
        table: rateLimits,
        secret: TEST_SECRET,
        clock,
        logger,
      }).rule({
        name: "login:ip",
        limit: 3,
        window: "1m",
      });
      const subject = "198.51.100.23";
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await rule.check(subject));

      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
      expect(results.every((r) => r.degraded === "memory")).toBe(true);
      expect(results[3]?.headers["Retry-After"]).toBe("60");
      // One line for the outage, not one per request, and nothing secret in it.
      expect(logger.lines).toHaveLength(1);
      expect(logger.lines[0]?.level).toBe("error");
      expect(JSON.stringify(logger.lines)).not.toContain(subject);
      expect(JSON.stringify(logger.lines)).not.toContain(TEST_SECRET);

      clock.advance("1m");
      expect(await rule.check(subject)).toMatchObject({ allowed: true, degraded: "memory" });
    } finally {
      await down.close().catch(() => {});
    }
  }, 30_000);

  test('onError "allow" and "deny" decide without the database', async () => {
    const down = unreachable();
    try {
      const limiter = createRateLimiter({
        db: down.db,
        table: rateLimits,
        secret: TEST_SECRET,
        logger: recordingLogger(),
      });
      const open = limiter.rule({ name: "open", limit: 1, window: "1m", onError: "allow" });
      const closed = limiter.rule({ name: "closed", limit: 1, window: "1m", onError: "deny" });
      for (let i = 0; i < 3; i++) {
        expect(await open.check("x")).toMatchObject({ allowed: true, degraded: "allow" });
      }
      const denied = await closed.check("x");
      expect(denied).toMatchObject({ allowed: false, degraded: "deny" });
      expect(denied.retryAfterMs).toBeGreaterThanOrEqual(1_000);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(5_000);
    } finally {
      await down.close().catch(() => {});
    }
  }, 30_000);

  test("falls back when a check waits longer than the timeout (here: a held row lock)", async () => {
    const clock = createTestClock(T0);
    const logger = recordingLogger();
    const name = unique("slow");
    const rule = createRateLimiter({
      db: database.current.db,
      table: rateLimits,
      secret: TEST_SECRET,
      clock,
      logger,
      timeout: "200ms",
    }).rule({ name, limit: 5, window: "1h" });
    const subject = unique("client");
    expect((await rule.check(subject)).degraded).toBe(false);

    const locker = database.current.connect({ max: 1 });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const key = keyFor("fixed-window", name, subject);
    const holding = locker.db.transaction(async (tx) => {
      await tx.execute(sql`select key from ${rateLimits} where key = ${key} for update`);
      locked();
      await released;
    });
    await isLocked;

    const started = performance.now();
    const slow = await rule.check(subject);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(slow.degraded).toBe("memory");
    expect(logger.lines.map((l) => l.level)).toEqual(["error"]);

    release();
    await holding;
    // The breaker skips the database for a few seconds, then tries it again.
    expect((await rule.check(subject)).degraded).toBe("memory");
    clock.advance("5s");
    expect((await rule.check(subject)).degraded).toBe(false);
    expect(logger.lines.map((l) => l.level)).toEqual(["error", "info"]);
  }, 30_000);
});

describe("createGroundwork", () => {
  test("wires the rate limiter to the app's database and tables", async () => {
    const gw = createGroundwork({
      db: database.current.db,
      tables: { rateLimits },
      secret: TEST_SECRET,
    });
    expect(gw.rateLimit).toBe(gw.rateLimit);
    const rule = gw.rateLimit.rule({ name: unique("gw"), limit: 1, window: "1m" });
    const subject = unique("client");
    expect((await rule.check(subject)).allowed).toBe(true);
    expect((await rule.check(subject)).allowed).toBe(false);
  });
});
