// Changing the secret with previousSecrets: API keys and idempotency keys stored under the old
// secret are still recognised. Rate limits start over, which needs no test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SQLWrapper, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { hashKey, parseKey } from "../../src/api-keys/format.ts";
import { type ApiKeysOptions, createApiKeys } from "../../src/api-keys/index.ts";
import { createIdempotency, type IdempotencyOptions } from "../../src/idempotency/index.ts";
import { createGroundwork } from "../../src/index.ts";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { apiKeys, idempotencyKeys } from "../fixtures/schema.ts";
import { type TestConnection, useTestDatabase } from "../support/database.ts";
import { recordingLogger, T0, TEST_SECRET, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();
const OLD = TEST_SECRET;
const NEW = "the-secret-after-the-change-0123456789abcdef";
const SCOPES = { "posts:read": "Read posts" };

type Secrets = Pick<ApiKeysOptions<typeof SCOPES>, "secret" | "previousSecrets">;
const before: Secrets = { secret: OLD };
const newOnly: Secrets = { secret: NEW };
const after: Secrets = { secret: NEW, previousSecrets: [OLD] };

function keysWith(secrets: Secrets, extra: Partial<ApiKeysOptions<typeof SCOPES>> = {}) {
  const pending: Promise<unknown>[] = [];
  const keys = createApiKeys({
    db: database.current.db,
    table: apiKeys,
    namespace: "rot",
    scopes: SCOPES,
    defaultRateLimit: null,
    waitUntil: (promise) => pending.push(promise),
    ...secrets,
    ...extra,
  });
  return Object.assign(keys, {
    /** Waits for background writes (lastUsedAt, moving a key's hash). */
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
  });
}

async function storedHash(id: string): Promise<string | undefined> {
  const [row] = await database.current.rows<{ key_hash: string }>(
    sql`select key_hash from ${apiKeys} where id = ${id}::uuid`,
  );
  return row?.key_hash;
}

/** What the stored hash is computed from: the key without its checksum. */
function bodyOf(key: string): string {
  const parsed = parseKey(key, "rot");
  if (!parsed) throw new Error("not a rot_ key");
  return parsed.body;
}

describe("API keys across a change of secret", () => {
  test("a key from before the change verifies, and moves to the new secret on first use", async () => {
    const { key, record } = await keysWith(before).create({ name: "CI", scopes: ["posts:read"] });

    // Without previousSecrets, changing the secret invalidates the key.
    expect(await keysWith(newOnly).verify(key)).toMatchObject({ ok: false, reason: "invalid" });

    const rotated = keysWith(after);
    expect(await rotated.verify(key, { scopes: ["posts:read"] })).toMatchObject({
      ok: true,
      key: { id: record.id },
    });
    await rotated.flush();
    // Moved: it now verifies under the new secret alone, and no longer under the old one.
    expect(await storedHash(record.id)).toBe(hashKey(deriveSubkey(NEW, "api-keys"), bodyOf(key)));
    expect((await keysWith(newOnly).verify(key)).ok).toBe(true);
    expect((await keysWith(before).verify(key)).ok).toBe(false);
    expect((await rotated.get(record.id))?.lastUsedAt).toBeInstanceOf(Date);
  });

  test("a key used a moment before the change still moves, and that use is recorded", async () => {
    const clock = createTestClock(T0);
    const old = keysWith(before, { clock });
    const { key, record } = await old.create({ name: "busy", scopes: ["posts:read"] });
    expect((await old.verify(key)).ok).toBe(true);
    await old.flush();
    expect((await old.get(record.id))?.lastUsedAt?.toISOString()).toBe(clock.now().toISOString());

    // Ten seconds later: inside the once-a-minute limit, but this use moves the key, so it's
    // written. A key used since the change therefore always has a lastUsedAt after it.
    clock.advance("10s");
    const rotated = keysWith(after, { clock });
    expect((await rotated.verify(key)).ok).toBe(true);
    await rotated.flush();
    expect((await rotated.get(record.id))?.lastUsedAt?.toISOString()).toBe(
      clock.now().toISOString(),
    );
    expect((await keysWith(newOnly, { clock }).verify(key)).ok).toBe(true);
  });

  test("verify waits for one statement, with every candidate hash in it", async () => {
    const { key } = await keysWith(before).create({ name: "counted", scopes: ["posts:read"] });
    const dialect = new PgDialect();
    const statements: string[] = [];
    // Background writes wait for this, so verify can only resolve if it doesn't wait for them.
    let releaseWrites!: () => void;
    const writesHeld = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const db = {
      execute: async (query: SQLWrapper) => {
        const text = dialect.sqlToQuery(query.getSQL()).sql;
        statements.push(text);
        if (text.trimStart().startsWith("update")) await writesHeld;
        return database.current.db.execute(query);
      },
    };
    const rotated = keysWith(
      { secret: NEW, previousSecrets: [OLD, "an-even-older-secret-0123456789abcdefghij"] },
      { db },
    );
    expect((await rotated.verify(key)).ok).toBe(true);
    // One lookup with the three candidates (new, old, older), for the key and its grace hash.
    expect(statements[0]).toMatch(
      /key_hash in \(\$\d+::text, \$\d+::text, \$\d+::text\)[\s\S]*previous_key_hash in \(\$\d+::text, \$\d+::text, \$\d+::text\)/,
    );
    // Moving the key, and recording this use, is one statement in the background.
    expect(statements.slice(1)).toEqual([expect.stringContaining("set key_hash")]);
    releaseWrites();
    await rotated.flush();
    expect(statements).toHaveLength(2);
    expect((await keysWith(newOnly).verify(key)).ok).toBe(true);
  });

  test("a two-step rollout: each side verifies the keys the other side creates", async () => {
    // Step 1 accepts the new secret everywhere while still writing the old one; step 2 swaps
    // them. Instances on either step verify each other's keys while the second deploy rolls out.
    const step1 = keysWith({ secret: OLD, previousSecrets: [NEW] });
    const step2 = keysWith(after);
    const fromStep1 = await step1.create({ name: "one", scopes: ["posts:read"] });
    const fromStep2 = await step2.create({ name: "two", scopes: ["posts:read"] });
    for (const { key } of [fromStep1, fromStep2]) {
      expect((await step1.verify(key)).ok).toBe(true);
      expect((await step2.verify(key)).ok).toBe(true);
    }
    await Promise.all([step1.flush(), step2.flush()]);
    expect((await step2.verify(fromStep1.key)).ok).toBe(true);
  });

  test("a key rotated out before the change still works for the rest of its grace period", async () => {
    const old = keysWith(before);
    const { key: first, record } = await old.create({ name: "rotating", scopes: ["posts:read"] });
    const rotatedKey = await old.rotate(record.id, { grace: "1h" });
    if (!rotatedKey) throw new Error("rotate() returned null");

    const rotated = keysWith(after);
    expect((await rotated.verify(first)).ok).toBe(true);
    expect((await rotated.verify(rotatedKey.key)).ok).toBe(true);
  });

  test("the docs' query lists exactly the keys that still need the old secret", async () => {
    // The query as docs/core-concepts.md prints it, so the docs can't drift from what's tested.
    const docs = readFileSync(
      join(import.meta.dir, "..", "..", "docs", "core-concepts.md"),
      "utf8",
    );
    const query = /```sql\n([\s\S]*?)```/
      .exec(docs.slice(docs.indexOf("**Drop the old secret**")))?.[1]
      ?.trim()
      .replace(/;$/, "");
    if (!query?.includes("from gw_api_keys")) throw new Error("The docs' query has moved.");
    const listed = async (id: string, stepTwoFinished: Date) => {
      const bound = sql.join(
        query.split(":step_2_finished").map((part) => sql.raw(part)),
        sql`${stepTwoFinished.toISOString()}::timestamptz`,
      );
      const rows = await database.current.rows(
        sql`select 1 from (${bound}) as listed where listed.id = ${id}::uuid`,
      );
      return rows.length === 1;
    };

    const clock = createTestClock(T0);
    const old = keysWith(before, { clock });
    const idle = await old.create({ name: "idle", scopes: ["posts:read"] });
    const { key: oldKey, record } = await old.create({ name: "rotated", scopes: ["posts:read"] });
    clock.advance("1m");
    const rotated = await old.rotate(record.id, { grace: "7d" });
    if (!rotated) throw new Error("rotate() returned null");
    clock.advance("1m");
    const stepTwoFinished = clock.now();
    clock.advance("1m");
    const stepTwo = keysWith(after, { clock });

    // Not used since the change: listed, and it does need the old secret.
    expect(await listed(idle.record.id, stepTwoFinished)).toBe(true);
    expect((await stepTwo.verify(idle.key)).ok).toBe(true);
    await stepTwo.flush();
    expect(await listed(idle.record.id, stepTwoFinished)).toBe(false);

    // Rotated before the change, and its old key used in the grace period: that moved nothing,
    // so the new key still needs the old secret. Before, the query missed this key.
    expect((await stepTwo.verify(oldKey)).ok).toBe(true);
    await stepTwo.flush();
    expect(await listed(record.id, stepTwoFinished)).toBe(true);
    expect((await keysWith(newOnly, { clock }).verify(rotated.key)).ok).toBe(false);

    // After the grace period a use can only be the new key, and that moves it.
    clock.advance("7d");
    expect((await stepTwo.verify(rotated.key)).ok).toBe(true);
    await stepTwo.flush();
    expect(await listed(record.id, stepTwoFinished)).toBe(false);
    expect((await keysWith(newOnly, { clock }).verify(rotated.key)).ok).toBe(true);
  });

  test("createGroundwork passes previousSecrets to gw.apiKeys", async () => {
    const { key } = await keysWith(before).create({ name: "gw", scopes: ["posts:read"] });
    const gw = createGroundwork({
      db: database.current.db,
      tables: { apiKeys },
      secret: NEW,
      previousSecrets: () => [OLD],
      apiKeys: { namespace: "rot", scopes: SCOPES, defaultRateLimit: null },
    });
    expect((await gw.apiKeys.verify(key)).ok).toBe(true);
  });
});

function idempotencyWith(
  target: Pick<TestConnection, "db">,
  secrets: Secrets,
  extra: Partial<IdempotencyOptions> = {},
) {
  const logger = recordingLogger();
  const instance = createIdempotency({
    db: target.db,
    table: idempotencyKeys,
    logger,
    ...secrets,
    ...extra,
  });
  return Object.assign(instance, { logger });
}

const post = (key: string, body: string) =>
  new Request("https://api.example.test/orders", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body,
  });
const created = (body: unknown) => Response.json(body, { status: 201 });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("idempotency across a change of secret", () => {
  test("run(): a result stored before the change is replayed after it, not run again", async () => {
    const db = database.current;
    const input = { scope: "webhooks", key: unique("evt") };
    let runs = 0;
    const charge = () => {
      runs += 1;
      return { charged: runs };
    };

    expect(await idempotencyWith(db, before).run(input, charge)).toEqual({
      ok: true,
      value: { charged: 1 },
      replayed: false,
    });
    expect(await idempotencyWith(db, after).run(input, charge)).toEqual({
      ok: true,
      value: { charged: 1 },
      replayed: true,
    });
    expect(runs).toBe(1);
    // Without previousSecrets the stored result isn't found, and the charge runs again.
    expect(await idempotencyWith(db, newOnly).run(input, charge)).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(runs).toBe(2);
  });

  test("handle(): a replay keeps its status and body, and another body is still a 422", async () => {
    const db = database.current;
    const key = unique("order");
    const first = await idempotencyWith(db, before).handle(
      post(key, '{"n":1}'),
      { scope: "u" },
      () => created({ order: 1 }),
    );
    expect(first.status).toBe(201);

    const rotated = idempotencyWith(db, after);
    const replay = await rotated.handle(post(key, '{"n":1}'), { scope: "u" }, () =>
      created({ order: 2 }),
    );
    expect([replay.status, await replay.json()]).toEqual([201, { order: 1 }]);
    const reused = await rotated.handle(post(key, '{"n":2}'), { scope: "u" }, () =>
      created({ order: 3 }),
    );
    expect(reused.status).toBe(422);
  });

  test("a request still running under the old secret gets a 409 after the change", async () => {
    const db = database.current;
    const key = unique("slow");
    const stuck = deferred<Response>();
    let started = false;
    const running = idempotencyWith(db.connect(), before).handle(
      post(key, "{}"),
      { scope: "u" },
      () => {
        started = true;
        return stuck.promise;
      },
    );
    await waitFor(() => started);

    const rotated = idempotencyWith(db, after);
    const duplicate = await rotated.handle(post(key, "{}"), { scope: "u" }, () => created({}));
    expect(duplicate.status).toBe(409);

    stuck.resolve(created({ by: "first" }));
    expect((await running).status).toBe(201);
    const replay = await rotated.handle(post(key, "{}"), { scope: "u" }, () => created({}));
    expect(await replay.json()).toEqual({ by: "first" });
  });

  test("a request that crashed under the old secret is taken over, and can't overwrite the rescuer", async () => {
    const clock = createTestClock(T0);
    const db = database.current;
    const key = unique("crash");
    const crashed = idempotencyWith(db.connect(), before, { clock, lease: "30s" });
    const rotated = idempotencyWith(db, after, { clock, lease: "30s" });
    const stuck = deferred<Response>();
    let started = false;
    const first = crashed.handle(post(key, "{}"), { scope: "u" }, () => {
      started = true;
      return stuck.promise;
    });
    await waitFor(() => started);

    // Abandoned, but another body is still a mismatch, as it is without a change of secret.
    clock.advance("31s");
    const other = await rotated.handle(post(key, '{"x":1}'), { scope: "u" }, () => created({}));
    expect(other.status).toBe(422);

    const takeover = await rotated.handle(post(key, "{}"), { scope: "u" }, () =>
      created({ by: "rescuer" }),
    );
    expect([takeover.status, await takeover.json()]).toEqual([201, { by: "rescuer" }]);

    // The crashed request finally returns. Its client gets its response, but it can't store it.
    stuck.resolve(created({ by: "crashed" }));
    expect(await (await first).json()).toEqual({ by: "crashed" });
    expect(crashed.logger.lines.map((line) => line.message)).toEqual([
      expect.stringContaining("lease ran out"),
    ]);
    const replay = await rotated.handle(post(key, "{}"), { scope: "u" }, () => created({}));
    expect(await replay.json()).toEqual({ by: "rescuer" });
  });

  test("concurrent retries after the change: a stored result is replayed to all of them", async () => {
    const db = database.current;
    const input = { scope: "race", key: unique("stored") };
    await idempotencyWith(db, before).run(input, () => ({ value: "stored" }));

    let runs = 0;
    const instances = Array.from({ length: 4 }, () =>
      idempotencyWith(db.connect({ max: 5 }), after),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        instances[i % instances.length]?.run(input, () => {
          runs += 1;
          return { value: "again" };
        }),
      ),
    );
    expect(runs).toBe(0);
    expect(results.every((r) => r?.ok === true && r.replayed && r.value.value === "stored")).toBe(
      true,
    );
  });

  test("concurrent takeovers of a request that crashed under the old secret: exactly one runs", async () => {
    const clock = createTestClock(T0);
    const db = database.current;
    const input = { scope: "race", key: unique("crashed") };
    const stuck = deferred<{ by: string }>();
    let started = false;
    void idempotencyWith(db.connect(), before, { clock, lease: "30s" }).run(input, () => {
      started = true;
      return stuck.promise;
    });
    await waitFor(() => started);
    clock.advance("31s");

    let runs = 0;
    const instances = Array.from({ length: 4 }, () =>
      idempotencyWith(db.connect({ max: 5 }), after, { clock, lease: "30s" }),
    );
    const release = deferred();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        instances[i % instances.length]?.run(input, async () => {
          runs += 1;
          await release.promise;
          return { by: "rescuer" };
        }),
      ).map(async (pending, i) => {
        // Let every duplicate answer before the one that claimed the key finishes.
        if (i === 19) setTimeout(() => release.resolve(), 200);
        return pending;
      }),
    );
    expect(runs).toBe(1);
    expect(results.filter((r) => r?.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r?.ok === false && r.reason === "in_progress")).toHaveLength(19);
    stuck.resolve({ by: "crashed" });
  });

  test("createGroundwork passes previousSecrets to gw.idempotency", async () => {
    const db = database.current;
    const input = { scope: "gw", key: unique("gw") };
    await idempotencyWith(db, before).run(input, () => 1);
    const gw = createGroundwork({
      db: db.db,
      tables: { idempotencyKeys },
      secret: NEW,
      previousSecrets: [OLD],
    });
    expect(await gw.idempotency.run(input, () => 2)).toEqual({
      ok: true,
      value: 1,
      replayed: true,
    });
  });
});

describe("idempotency during the two-deploy rollout", () => {
  const step1: Secrets = { secret: OLD, previousSecrets: [NEW] };
  const step2: Secrets = { secret: NEW, previousSecrets: [OLD] };

  /**
   * An instance whose first statement (the claim) runs in a transaction that stays open until
   * `commit()`, so another instance's claim runs while this one is still uncommitted.
   */
  function heldClaim(secrets: Secrets) {
    const connection = database.current.connect({ max: 2 });
    const commitNow = deferred();
    let held: Promise<unknown> | undefined;
    const db = {
      execute(query: SQLWrapper) {
        if (held !== undefined) return connection.db.execute(query);
        const ran = Promise.withResolvers<unknown>();
        held = connection.db
          .transaction(async (tx) => {
            ran.resolve(await tx.execute(query));
            await commitNow.promise;
          })
          .catch(ran.reject);
        return ran.promise;
      },
    };
    return {
      instance: idempotencyWith({ db: db as never }, secrets),
      commit: async () => {
        commitNow.resolve();
        await held;
      },
    };
  }

  async function someoneWaitsForALockOr(stop: () => boolean) {
    const deadline = Date.now() + 10_000;
    while (!stop()) {
      const [row] = await database.current.rows<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if ((row?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  for (const [firstName, first, secondName, second] of [
    ["step 1", step1, "step 2", step2],
    ["step 2", step2, "step 1", step1],
  ] as const) {
    test(`a copy on ${secondName} waits for the claim on ${firstName}, and doesn't run`, async () => {
      const input = { scope: "rollout", key: unique("copy") };
      const held = heldClaim(first);
      const release = deferred();
      let firstRan = false;
      let secondRan = false;
      const firstRun = held.instance.run(input, async () => {
        firstRan = true;
        await release.promise;
        return "first";
      });
      await waitFor(() => firstRan);

      const secondRun = idempotencyWith(database.current, second).run(input, () => {
        secondRan = true;
        return "second";
      });
      // Before, the second claim used another key, didn't wait, and ran the work again.
      await someoneWaitsForALockOr(() => secondRan);
      await held.commit();
      // The first is still running until it's released, so the second can only see it running.
      expect(await secondRun).toEqual({ ok: false, reason: "in_progress" });
      expect(secondRan).toBe(false);
      release.resolve();
      expect(await firstRun).toEqual({ ok: true, value: "first", replayed: false });

      // Once it's done, both steps replay it, and so does an instance after the old secret is
      // dropped: the claim was stored under the new secret too, whichever step made it.
      for (const secrets of [first, second, newOnly]) {
        expect(await idempotencyWith(database.current, secrets).run(input, () => "again")).toEqual({
          ok: true,
          value: "first",
          replayed: true,
        });
      }
    }, 30_000);
  }

  test("simultaneous copies on both steps run once", async () => {
    let runs = 0;
    const instances = [step1, step2].map((secrets) =>
      idempotencyWith(database.current.connect({ max: 10 }), secrets),
    );
    for (let round = 0; round < 3; round++) {
      const keys = Array.from({ length: 50 }, () => unique("pair"));
      await Promise.all(
        keys.flatMap((key) =>
          instances.map((instance) =>
            instance?.run({ scope: "pairs", key }, () => {
              runs += 1;
              return 1;
            }),
          ),
        ),
      );
    }
    expect(runs).toBe(150);
  }, 60_000);

  test("a request that outlives its ttl under the old secret isn't run again after the change", async () => {
    const clock = createTestClock(T0);
    const input = { scope: "slow", key: unique("slow"), ttl: "2s" as const };
    const release = deferred();
    let started = false;
    const slow = idempotencyWith(database.current.connect(), before, { clock, lease: "30s" }).run(
      input,
      async () => {
        started = true;
        await release.promise;
        return "slow";
      },
    );
    await waitFor(() => started);
    clock.advance("5s");

    // Past its ttl, but its lease is live: the same secret says in_progress, and so must this.
    let ranAgain = false;
    expect(
      await idempotencyWith(database.current, after, { clock, lease: "30s" }).run(input, () => {
        ranAgain = true;
        return "again";
      }),
    ).toEqual({ ok: false, reason: "in_progress" });
    expect(ranAgain).toBe(false);
    release.resolve();
    await slow;
  });

  test("a claim taken over in part can't store its result", async () => {
    const clock = createTestClock(T0);
    const input = { scope: "partial", key: unique("partial") };
    const release = deferred();
    let started = false;
    // Claimed on step 2, under the new secret and the old one…
    const zombie = idempotencyWith(database.current.connect(), step2, { clock, lease: "30s" });
    const zombieRun = zombie.run(input, async () => {
      started = true;
      await release.promise;
      return "zombie";
    });
    await waitFor(() => started);
    clock.advance("31s");
    // …then its worker stalls, and an instance that only knows the new secret takes over that row.
    const rescuer = idempotencyWith(database.current, newOnly, { clock, lease: "30s" });
    expect(await rescuer.run(input, () => "rescuer")).toEqual({
      ok: true,
      value: "rescuer",
      replayed: false,
    });

    // The stalled worker finishes: it still holds the old secret's row, but not every row.
    release.resolve();
    expect(await zombieRun).toEqual({ ok: true, value: "zombie", replayed: false });
    expect(zombie.logger.lines.map((line) => line.message)).toEqual([
      expect.stringContaining("lease ran out"),
    ]);
    for (const secrets of [step2, newOnly]) {
      expect(
        await idempotencyWith(database.current, secrets, { clock }).run(input, () => "again"),
      ).toMatchObject({ ok: true, value: "rescuer", replayed: true });
    }
  });
});
