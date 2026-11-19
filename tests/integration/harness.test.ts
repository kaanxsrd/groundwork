import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { altRateLimits, rateLimits } from "../fixtures/schema.ts";
import { createTestDatabase, testDriver, useTestDatabase } from "../support/database.ts";

const database = useTestDatabase();

const probeRow = (key: string) => ({
  key,
  rule: "harness",
  used: 1,
  updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
});

describe("test harness", () => {
  test("runs on a supported Postgres major with the configured driver", async () => {
    const [row] = await database.current.rows<{ server_version_num: string }>(
      sql`show server_version_num`,
    );
    const major = Math.floor(Number(row?.server_version_num) / 10_000);
    expect(major).toBeGreaterThanOrEqual(16);
    expect(database.current.driver).toBe(testDriver());
  });

  test("creates the tables drizzle-kit generated from the fixture schema", async () => {
    const tables = await database.current.rows<{ table_schema: string; table_name: string }>(sql`
      select table_schema, table_name from information_schema.tables
      where table_name like '%rate_limits' order by table_schema`);
    expect(tables).toEqual([
      { table_schema: "groundwork_alt", table_name: "alt_rate_limits" },
      { table_schema: "public", table_name: "gw_rate_limits" },
    ]);
  });

  test("reads and writes through Drizzle", async () => {
    const { db } = database.current;
    const [inserted] = await db.insert(rateLimits).values(probeRow("hello")).returning();
    expect(inserted?.key).toBe("hello");
    expect(inserted?.expiresAt).toBeInstanceOf(Date);

    await db.insert(altRateLimits).values(probeRow("in-alt-schema"));
    const found = await db.select().from(rateLimits).where(eq(rateLimits.key, "hello"));
    expect(found).toHaveLength(1);
    const alt = await db.select().from(altRateLimits);
    expect(alt.map((r) => r.key)).toEqual(["in-alt-schema"]);
  });

  test("a rolled-back transaction leaves nothing behind", async () => {
    const { db } = database.current;
    const rollback = new Error("roll back");
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(rateLimits).values(probeRow("rolled-back"));
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const found = await db.select().from(rateLimits).where(eq(rateLimits.key, "rolled-back"));
    expect(found).toHaveLength(0);
  });

  test("each test database is isolated from the others", async () => {
    await database.current.db.insert(rateLimits).values(probeRow("only-in-first"));
    const other = await createTestDatabase();
    try {
      expect(other.name).not.toBe(database.current.name);
      const rows = await other.db.select().from(rateLimits);
      expect(rows).toHaveLength(0);
    } finally {
      await other.close();
    }
    const rows = await database.current.rows<{ datname: string }>(
      sql`select datname from pg_database where datname = ${other.name}`,
    );
    expect(rows).toHaveLength(0);
  });

  test("independent pools write concurrently to the same database", async () => {
    const a = database.current.connect({ max: 5 });
    const b = database.current.connect({ max: 5 });
    const labels = Array.from({ length: 50 }, (_, i) => `concurrent-${i}`);
    await Promise.all(
      labels.map((label, i) => (i % 2 === 0 ? a : b).db.insert(rateLimits).values(probeRow(label))),
    );
    const [row] = await database.current.rows<{ count: string | number }>(
      sql`select count(*) as count from ${rateLimits} where ${rateLimits.key} like 'concurrent-%'`,
    );
    expect(Number(row?.count)).toBe(50);
  });

  test("queries really run in parallel (race tests are not silently serialised)", async () => {
    const pool = database.current.connect({ max: 5 });
    const started = performance.now();
    await Promise.all(Array.from({ length: 5 }, () => pool.db.execute(sql`select pg_sleep(0.3)`)));
    const elapsed = performance.now() - started;
    // Serially this takes 1.5s; in parallel about 0.3s plus connection setup.
    expect(elapsed).toBeLessThan(1_200);
  });
});
