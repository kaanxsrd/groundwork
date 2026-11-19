// Runs in the smoke project under plain Node: migrates a fresh database with the SQL drizzle-kit
// generated from groundworkTables(), then rate-limits against it through the published API.
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createGroundwork } from "groundwork";
import { groundworkTables } from "groundwork/schema";
import postgres from "postgres";

const maintenanceUrl = process.env.SMOKE_DATABASE_URL;
const migrationsFolder = process.env.SMOKE_MIGRATIONS;
assert.ok(maintenanceUrl && migrationsFolder, "SMOKE_DATABASE_URL and SMOKE_MIGRATIONS are set");

const admin = postgres(maintenanceUrl, { max: 1, onnotice: () => {} });
const name = `gw_smoke_${Date.now().toString(36)}`;
await admin.unsafe(`create database "${name}"`);
try {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 4, onnotice: () => {} });
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder });

  const gw = createGroundwork({
    db,
    tables: groundworkTables(),
    secret: "smoke-test-secret-0123456789abcdefghij",
  });
  const rule = gw.rateLimit.rule({ name: "smoke", limit: 2, window: "1m" });
  const results = await Promise.all([1, 2, 3, 4].map(() => rule.check("203.0.113.9")));
  assert.equal(results.filter((r) => r.allowed).length, 2);
  assert.ok(
    results.every((r) => r.degraded === false),
    "Postgres answered, not the fallback",
  );
  assert.match(results.find((r) => !r.allowed)?.headers["Retry-After"] ?? "", /^\d+$/);

  const [row] = await client`select used, key from gw_rate_limits`;
  assert.equal(row.used, 2);
  assert.notEqual(row.key, "203.0.113.9");
  await client.end();
} finally {
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.end();
}
