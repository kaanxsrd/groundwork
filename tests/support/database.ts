// Test harness: every test file gets its own Postgres database.
//
// 1. A template database is migrated once from tests/migrations (the SQL drizzle-kit generated
//    from tests/fixtures/schema.ts). Its name contains a hash of the migrations, so changing a
//    migration builds a fresh template automatically.
// 2. Each test file clones the template with CREATE DATABASE ... TEMPLATE, which takes
//    milliseconds, and drops its clone when the file finishes.
// 3. Template builds and clones run under an advisory lock on the maintenance database, so
//    `bun test --parallel` (several worker processes) is safe.
//
// TEST_DATABASE_URL points at the maintenance database (default: the docker compose one).
// GW_TEST_DRIVER picks the driver the tests use: postgres-js (default) or node-postgres.

import { afterAll, beforeAll } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { SQL } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import pg from "pg";
import postgres from "postgres";

export const DEFAULT_TEST_DATABASE_URL =
  "postgres://groundwork:groundwork@127.0.0.1:54330/groundwork";

export type TestDriver = "postgres-js" | "node-postgres";

/** Any Drizzle Postgres database, whichever driver created it. This is what groundwork accepts. */
export type AnyPgDatabase = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface TestConnection {
  readonly db: AnyPgDatabase;
  readonly driver: TestDriver;
  close(): Promise<void>;
}

export interface TestDatabase extends TestConnection {
  /** Name of this file's database. */
  readonly name: string;
  /** Connection URL of this file's database. */
  readonly url: string;
  /**
   * Opens another, independent connection pool to the same database, for example to simulate a
   * second app instance in a race test. It is closed together with the database.
   */
  connect(options?: { readonly max?: number }): TestConnection;
  /** Runs raw SQL and returns its rows, whichever driver is in use. */
  rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]>;
}

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "migrations");
const TEMPLATE_PREFIX = "gw_template_";
const DATABASE_PREFIX = "gw_test_";
const STALE_AFTER_MS = 60 * 60 * 1000;
// Any constant works; it only has to be the same for every process that runs the tests.
const LOCK_KEY = 0x67_77_74_68; // "gwth"
const SAFE_IDENTIFIER = /^[a-z0-9_]+$/;

export function testDriver(): TestDriver {
  const value = process.env.GW_TEST_DRIVER ?? "postgres-js";
  if (value !== "postgres-js" && value !== "node-postgres") {
    throw new Error(`GW_TEST_DRIVER must be postgres-js or node-postgres, not ${value}`);
  }
  return value;
}

function maintenanceUrl(): string {
  return process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
}

function urlFor(database: string): string {
  const url = new URL(maintenanceUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`Refusing unsafe database name: ${name}`);
  return `"${name}"`;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Hash of every migration file, so the template name changes whenever a migration does. */
export function migrationsHash(): string {
  const hash = createHash("sha256");
  for (const file of listFiles(MIGRATIONS_FOLDER).sort()) {
    hash.update(relative(MIGRATIONS_FOLDER, file).replaceAll("\\", "/"));
    hash.update("\0");
    // Normalise line endings so a Windows checkout produces the same hash as CI.
    hash.update(readFileSync(file, "utf8").replaceAll("\r\n", "\n"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function quiet(): postgres.Options<Record<string, postgres.PostgresType>> {
  return { onnotice: () => {} };
}

async function withMaintenanceLock<T>(fn: (admin: postgres.Sql) => Promise<T>): Promise<T> {
  // One connection, so the session-level advisory lock and the DDL share a session.
  const admin = postgres(maintenanceUrl(), { ...quiet(), max: 1 });
  try {
    await admin`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      return await fn(admin);
    } finally {
      await admin`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function databaseExists(admin: postgres.Sql, name: string): Promise<boolean> {
  const found = await admin`select 1 from pg_database where datname = ${name}`;
  return found.length > 0;
}

async function dropStaleDatabases(admin: postgres.Sql, currentTemplate: string): Promise<void> {
  const databases = await admin<{ datname: string }[]>`
    select datname from pg_database
    where datname like ${`${TEMPLATE_PREFIX}%`} or datname like ${`${DATABASE_PREFIX}%`}`;
  for (const { datname } of databases) {
    if (datname === currentTemplate) continue;
    let stale = datname.startsWith(TEMPLATE_PREFIX);
    if (datname.startsWith(DATABASE_PREFIX)) {
      const createdAt = Number.parseInt(
        datname.slice(DATABASE_PREFIX.length).split("_")[0] ?? "",
        36,
      );
      stale = Number.isFinite(createdAt) && Date.now() - createdAt > STALE_AFTER_MS;
    }
    if (!stale) continue;
    // Without FORCE: a template another run is still cloning from stays put.
    await admin.unsafe(`drop database if exists ${quoteIdentifier(datname)}`).catch(() => {});
  }
}

async function ensureTemplate(admin: postgres.Sql): Promise<string> {
  const template = `${TEMPLATE_PREFIX}${migrationsHash()}`;
  if (await databaseExists(admin, template)) return template;

  // Migrate under a temporary name and rename at the end, so a failed migration never leaves a
  // half-built template behind that later runs would trust.
  const building = `${template}_${randomBytes(3).toString("hex")}`;
  await admin.unsafe(`create database ${quoteIdentifier(building)}`);
  const client = postgres(urlFor(building), { ...quiet(), max: 1 });
  try {
    await migrate(drizzlePostgresJs({ client }), { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (error) {
    await client.end({ timeout: 5 });
    await admin.unsafe(`drop database if exists ${quoteIdentifier(building)} with (force)`);
    throw error;
  }
  await client.end({ timeout: 5 });
  await admin.unsafe(
    `alter database ${quoteIdentifier(building)} rename to ${quoteIdentifier(template)}`,
  );
  await dropStaleDatabases(admin, template);
  return template;
}

/** Opens a pool to any URL with the given driver, for example one that points at nothing. */
export function openConnection(url: string, driver: TestDriver, max: number): TestConnection {
  if (driver === "postgres-js") {
    const client = postgres(url, { ...quiet(), max });
    return {
      db: drizzlePostgresJs({ client }),
      driver,
      close: () => client.end({ timeout: 5 }),
    };
  }
  const pool = new pg.Pool({ connectionString: url, max });
  // An idle client that errors (for example when the database is dropped) must not crash the run.
  pool.on("error", () => {});
  return { db: drizzleNodePg({ client: pool }), driver, close: () => pool.end() };
}

/** Normalises `db.execute()` results: postgres-js returns an array, node-postgres `{ rows }`. */
function toRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  if (Array.isArray(rows)) return rows as T[];
  throw new Error("Unexpected db.execute() result shape");
}

/** Creates a fresh database for one test file. Prefer {@link useTestDatabase} inside tests. */
export async function createTestDatabase(
  options: { readonly driver?: TestDriver; readonly max?: number } = {},
): Promise<TestDatabase> {
  const driver = options.driver ?? testDriver();
  const name = `${DATABASE_PREFIX}${Date.now().toString(36)}_${process.pid}_${randomBytes(3).toString("hex")}`;

  await withMaintenanceLock(async (admin) => {
    const template = await ensureTemplate(admin);
    await admin.unsafe(
      `create database ${quoteIdentifier(name)} template ${quoteIdentifier(template)}`,
    );
  });

  const url = urlFor(name);
  const main = openConnection(url, driver, options.max ?? 10);
  const extra: TestConnection[] = [];
  let closed = false;

  return {
    ...main,
    name,
    url,
    connect: ({ max = 10 } = {}) => {
      const connection = openConnection(url, driver, max);
      extra.push(connection);
      return connection;
    },
    rows: async <T extends Record<string, unknown>>(query: SQL) =>
      toRows<T>(await main.db.execute(query)),
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([main.close(), ...extra.map((connection) => connection.close())]);
      const admin = postgres(maintenanceUrl(), { ...quiet(), max: 1 });
      try {
        await admin.unsafe(`drop database if exists ${quoteIdentifier(name)} with (force)`);
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}

/**
 * Gives the current test file its own database: created in `beforeAll`, dropped in `afterAll`.
 *
 * ```ts
 * const database = useTestDatabase();
 * test("…", async () => { await database.current.db.select()… });
 * ```
 */
export function useTestDatabase(options: { readonly max?: number } = {}): {
  readonly current: TestDatabase;
} {
  let database: TestDatabase | undefined;
  beforeAll(async () => {
    database = await createTestDatabase(options);
  }, 60_000);
  afterAll(async () => {
    await database?.close();
  }, 60_000);
  return {
    get current(): TestDatabase {
      if (!database) throw new Error("The test database is only available inside tests and hooks.");
      return database;
    },
  };
}
