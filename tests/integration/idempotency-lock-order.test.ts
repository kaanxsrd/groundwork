// With previousSecrets, one idempotency claim holds a row per secret. Every statement that locks
// several of those rows must lock them in the same order (byte order), or a claim and another
// statement can each hold one row and wait for the other: a deadlock, which Postgres resolves by
// aborting one of them. CI's Postgres sorts text in byte order, which hides the bug, so this file
// gives the key column a collation that sorts otherwise and makes the planner use the index.
//
// Its own file because it changes the table and the database's planner settings.
import { expect, test } from "bun:test";
import { type SQLWrapper, sql } from "drizzle-orm";
import { createIdempotency } from "../../src/idempotency/index.ts";
import { createKeyHasher } from "../../src/idempotency/keys.ts";
import { deriveSubkey } from "../../src/internal/crypto.ts";
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

async function untilLockWaiters(n: number) {
  const deadline = Date.now() + 10_000;
  for (;;) {
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
function instance(connection: TestConnection) {
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
    idempotency: createIdempotency({ db, table: idempotencyKeys, logger, ...STEP_2 }),
    errors,
    logger,
  };
}

test("giving back a claim can't deadlock with a duplicate's claim, whatever order Postgres reads rows in", async () => {
  const db = database.current;
  await db.rows(sql`alter table ${idempotencyKeys} alter column key type text collate "en-x-icu"`);
  await db.rows(sql.raw(`alter database "${db.name}" set enable_seqscan = off`));
  await db.rows(sql.raw(`alter database "${db.name}" set enable_bitmapscan = off`));

  // A client key whose two stored keys sort one way in bytes and the other way in the collation.
  const underNew = createKeyHasher(() => deriveSubkey(NEW, "idempotency"));
  const underOld = createKeyHasher(() => deriveSubkey(OLD, "idempotency"));
  let clientKey = "";
  let byteFirst = "";
  for (let i = 0; !clientKey; i++) {
    const candidate = `key-${i}`;
    const a = underNew.storageKey("run", "lock-order", candidate);
    const b = underOld.storageKey("run", "lock-order", candidate);
    const [low, high] = a < b ? [a, b] : [b, a];
    const [row] = await db.rows<{ reversed: boolean }>(
      sql`select ${high}::text collate "en-x-icu" < ${low}::text collate "en-x-icu" as reversed`,
    );
    if (row?.reversed) {
      clientKey = candidate;
      byteFirst = low;
    }
  }
  const input = { scope: "lock-order", key: clientKey };

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
  const deadline = Date.now() + 10_000;
  while (!started) {
    if (Date.now() > deadline) throw new Error("the first request never started");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Only a sequencer: it lines up the interleaving that two concurrent statements hit by chance.
  const sequencer = db.connect({ max: 1 });
  const locked = deferred();
  const unlock = deferred();
  const holding = sequencer.db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${idempotencyKeys} where key = ${byteFirst} for update`);
    locked.resolve();
    await unlock.promise;
  });
  await locked.promise;

  // A duplicate arrives. Its claim takes the rows in byte order, so it waits on byteFirst.
  const second = duplicate.idempotency.run(input, () => "duplicate");
  await untilLockWaiters(1);
  // The first request's handler fails, so it gives its rows back. Before, that delete took
  // byteSecond first (index order) and waited on byteFirst, while the duplicate would take
  // byteFirst and wait on byteSecond.
  handlerFails.resolve();
  await untilLockWaiters(2);
  unlock.resolve();
  await holding;

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
