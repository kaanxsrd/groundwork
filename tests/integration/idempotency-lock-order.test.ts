// With previousSecrets, one idempotency claim holds a row per secret. Every statement that locks
// several of those rows must lock them in the same order (byte order), or a claim and another
// statement can each hold one row and wait for the other: a deadlock, which Postgres resolves by
// aborting one of them. CI's Postgres sorts text in byte order, which hides the bug, so this file
// gives the key column a collation that sorts otherwise and makes the planner use the index.
//
// Its own file because it changes the table and the database's planner settings.
import { expect, test } from "bun:test";
import { type SQLWrapper, sql } from "drizzle-orm";
import { createIdempotency, type IdempotencyOptions } from "../../src/idempotency/index.ts";
import { createKeyHasher } from "../../src/idempotency/keys.ts";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { idempotencyKeys } from "../fixtures/schema.ts";
import { type TestConnection, useTestDatabase } from "../support/database.ts";
import { recordingLogger, TEST_SECRET } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();
const OLD = TEST_SECRET;
const NEW = "the-secret-after-the-change-0123456789abcdef";
const STEP_2 = { secret: NEW, previousSecrets: [OLD] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits until `n` statements wait for a lock, or until `unless()` is true. */
async function untilLockWaiters(n: number, unless: () => boolean = () => false) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (unless()) return;
    const [row] = await database.current.rows<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((row?.waiting ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`never saw ${n} statements waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** An idempotency instance on its own pool, keeping every error its database raises. */
function instance(connection: TestConnection, extra: Partial<IdempotencyOptions> = {}) {
  const errors: unknown[] = [];
  const logger = recordingLogger();
  const db = {
    async execute(query: SQLWrapper) {
      try {
        return await connection.db.execute(query);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    },
  };
  return {
    idempotency: createIdempotency({ db, table: idempotencyKeys, logger, ...STEP_2, ...extra }),
    errors,
    logger,
  };
}

/** Sorts the key column in a collation that isn't byte order, and makes the planner use indexes. */
async function scrambleRowOrder() {
  const db = database.current;
  await db.rows(sql`alter table ${idempotencyKeys} alter column key type text collate "en-x-icu"`);
  await db.rows(sql.raw(`alter database "${db.name}" set enable_seqscan = off`));
  await db.rows(sql.raw(`alter database "${db.name}" set enable_bitmapscan = off`));
}

/** A client key whose two stored keys sort one way in bytes and the other way in the collation. */
async function reversedKey(scope: string) {
  const underNew = createKeyHasher(() => deriveSubkey(NEW, "idempotency"));
  const underOld = createKeyHasher(() => deriveSubkey(OLD, "idempotency"));
  for (let i = 0; ; i++) {
    const candidate = `key-${i}`;
    const a = underNew.storageKey("run", scope, candidate);
    const b = underOld.storageKey("run", scope, candidate);
    const [low, high] = a < b ? [a, b] : [b, a];
    const [row] = await database.current.rows<{ reversed: boolean }>(
      sql`select ${high}::text collate "en-x-icu" < ${low}::text collate "en-x-icu" as reversed`,
    );
    if (row?.reversed)
      return { input: { scope, key: candidate }, byteFirst: low, byteSecond: high };
  }
}

/**
 * Locks one row on its own connection until `unlock` is called. Only a sequencer: it lines up
 * the interleaving that concurrent statements hit by chance.
 */
async function lockRow(key: string) {
  const sequencer = database.current.connect({ max: 1 });
  const locked = deferred();
  const release = deferred();
  const holding = sequencer.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${idempotencyKeys} where key = ${key} for update`);
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  return async () => {
    release.resolve();
    await holding;
  };
}

/** Waits until the request's handler has started. */
async function untilStarted(started: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!started()) {
    if (Date.now() > deadline) throw new Error("the first request never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("giving back a claim can't deadlock with a duplicate's claim, whatever order Postgres reads rows in", async () => {
  const db = database.current;
  await scrambleRowOrder();
  const { input, byteFirst } = await reversedKey("lock-order");

  // New connections, so they pick up the planner settings.
  const holder = instance(db.connect({ max: 3 }));
  const duplicate = instance(db.connect({ max: 3 }));
  const handlerFails = deferred();
  let started = false;
  const first = holder.idempotency
    .run(input, async () => {
      started = true;
      await handlerFails.promise;
      throw new Error("handler failed");
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error: String(error) }),
    );
  await untilStarted(() => started);
  const unlock = await lockRow(byteFirst);

  // A duplicate arrives. Its claim takes the rows in byte order, so it waits on byteFirst.
  const second = duplicate.idempotency.run(input, () => "duplicate");
  await untilLockWaiters(1);
  // The first request's handler fails, so it gives its rows back. Before, that delete took
  // byteSecond first (index order) and waited on byteFirst, while the duplicate would take
  // byteFirst and wait on byteSecond.
  handlerFails.resolve();
  await untilLockWaiters(2);
  await unlock();

  expect(await first).toEqual({ error: "Error: handler failed" });
  expect(await second).toEqual({ ok: false, reason: "in_progress" });
  expect([...holder.errors, ...duplicate.errors]).toEqual([]);
  expect([...holder.logger.lines, ...duplicate.logger.lines]).toEqual([]);
  // The rows were given back, so the client's retry runs.
  expect(await duplicate.idempotency.run(input, () => "retried")).toEqual({
    ok: true,
    value: "retried",
    replayed: false,
  });
}, 60_000);

test("renewing a lease can't deadlock with a duplicate's claim, whatever order Postgres reads rows in", async () => {
  const db = database.current;
  await scrambleRowOrder();
  const { input, byteFirst } = await reversedKey("lock-order-heartbeat");
  // The clock stands still, so the lease never runs out, while the heartbeat (every third of
  // a second) keeps renewing it.
  const clock = createTestClock("2026-04-01T00:00:00Z");
  const holder = instance(db.connect({ max: 3 }), { clock, lease: "1s" });
  const duplicate = instance(db.connect({ max: 3 }), { clock, lease: "1s" });
  const finish = deferred();
  let started = false;
  const first = holder.idempotency.run(input, async () => {
    started = true;
    await finish.promise;
    return "first";
  });
  await untilStarted(() => started);
  const unlock = await lockRow(byteFirst);

  // The duplicate's claim waits on byteFirst. Then the heartbeat renews the lease. Before, it
  // took byteSecond first (index order) and waited on byteFirst, while the duplicate would take
  // byteFirst and wait on byteSecond.
  const second = duplicate.idempotency.run(input, () => "duplicate");
  await untilLockWaiters(1);
  await untilLockWaiters(2);
  await unlock();

  expect(await second).toEqual({ ok: false, reason: "in_progress" });
  finish.resolve();
  expect(await first).toEqual({ ok: true, value: "first", replayed: false });
  expect([...holder.errors, ...duplicate.errors]).toEqual([]);
  expect([...holder.logger.lines, ...duplicate.logger.lines]).toEqual([]);
}, 60_000);

test("cleanup skips the rows a claim is taking over instead of deadlocking with it", async () => {
  const db = database.current;
  await scrambleRowOrder();
  const { input, byteFirst, byteSecond } = await reversedKey("lock-order-cleanup");
  // Only this test's rows, so cleanup's count is about them.
  await db.rows(sql`delete from ${idempotencyKeys}`);
  const owner = instance(db.connect({ max: 3 }));
  expect(await owner.idempotency.run(input, () => "first")).toMatchObject({ ok: true });
  // Both rows have expired. byteSecond expired first, so cleanup's scan reaches it first.
  await db.rows(sql`update ${idempotencyKeys} set expires_at = now() - interval '1 hour'
    where key in (${byteFirst}, ${byteSecond})`);
  await db.rows(sql`update ${idempotencyKeys} set expires_at = now() - interval '2 hours'
    where key = ${byteSecond}`);
  const unlock = await lockRow(byteFirst);

  // A new request with the key takes the expired rows over, in byte order: it waits on byteFirst.
  const retry = instance(db.connect({ max: 3 }));
  const second = retry.idempotency.run(input, () => "again");
  await untilLockWaiters(1);
  // Cleanup runs meanwhile. Before, it deleted byteSecond and waited on byteFirst, while the
  // claim would take byteFirst and wait on byteSecond.
  const cleaner = instance(db.connect({ max: 3 }));
  let cleaned = false;
  const cleaning = cleaner.idempotency.cleanup().then(
    (deleted) => {
      cleaned = true;
      return { deleted };
    },
    (error: unknown) => {
      cleaned = true;
      // The database's own error, not Drizzle's "Failed query" around it.
      return { error: String((error as { cause?: unknown }).cause ?? error) };
    },
  );
  await untilLockWaiters(2, () => cleaned);
  await unlock();

  // It deleted the row nobody was using, and left the one the claim was waiting for.
  expect(await cleaning).toEqual({ deleted: 1 });
  expect(await second).toEqual({ ok: true, value: "again", replayed: false });
  expect([...retry.errors, ...cleaner.errors]).toEqual([]);
  expect([...retry.logger.lines, ...cleaner.logger.lines]).toEqual([]);
  const rows = await db.rows<{ key: string }>(
    sql`select key from ${idempotencyKeys} where key in (${byteFirst}, ${byteSecond}) and completed_at is not null`,
  );
  expect(rows).toHaveLength(2);
}, 60_000);
