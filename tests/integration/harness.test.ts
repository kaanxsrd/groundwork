import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { harnessProbe } from "../fixtures/schema.ts";
import { createTestDatabase, testDriver, useTestDatabase } from "../support/database.ts";

const database = useTestDatabase();

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
    const columns = await database.current.rows<{ column_name: string; data_type: string }>(sql`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'gw_harness_probe'
      order by ordinal_position`);
    expect(columns).toEqual([
      { column_name: "id", data_type: "bigint" },
      { column_name: "label", data_type: "text" },
      { column_name: "created_at", data_type: "timestamp with time zone" },
    ]);
  });

  test("reads and writes through Drizzle", async () => {
    const { db } = database.current;
    const [inserted] = await db.insert(harnessProbe).values({ label: "hello" }).returning();
    expect(inserted?.label).toBe("hello");
    expect(inserted?.createdAt).toBeInstanceOf(Date);

    const found = await db.select().from(harnessProbe).where(eq(harnessProbe.label, "hello"));
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(inserted?.id ?? -1);
  });

  test("a rolled-back transaction leaves nothing behind", async () => {
    const { db } = database.current;
    const rollback = new Error("roll back");
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(harnessProbe).values({ label: "rolled-back" });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const found = await db.select().from(harnessProbe).where(eq(harnessProbe.label, "rolled-back"));
    expect(found).toHaveLength(0);
  });

  test("each test database is isolated from the others", async () => {
    await database.current.db.insert(harnessProbe).values({ label: "only-in-first" });
    const other = await createTestDatabase();
    try {
      expect(other.name).not.toBe(database.current.name);
      const rows = await other.db.select().from(harnessProbe);
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
      labels.map((label, i) => (i % 2 === 0 ? a : b).db.insert(harnessProbe).values({ label })),
    );
    const [row] = await database.current.rows<{ count: string | number }>(
      sql`select count(*) as count from ${harnessProbe} where ${harnessProbe.label} like 'concurrent-%'`,
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
