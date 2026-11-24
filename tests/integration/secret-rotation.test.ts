// Changing the secret with previousSecrets: API keys and idempotency keys stored under the old
// secret are still recognised. Rate limits start over, which needs no test.
import { describe, expect, test } from "bun:test";
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
