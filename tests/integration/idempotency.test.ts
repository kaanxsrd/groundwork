import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createIdempotency, type IdempotencyOptions } from "../../src/idempotency/index.ts";
import { createGroundwork } from "../../src/index.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";
import { createTestClock } from "../../src/testing/index.ts";
import {
  altIdempotencyKeys,
  idempotencyKeys,
  jobSchedules,
  jobs,
  rateLimits,
} from "../fixtures/schema.ts";
import { type TestConnection, useTestDatabase } from "../support/database.ts";
import { recordingLogger, T0, TEST_SECRET, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();

function idempotencyOn(
  target: Pick<TestConnection, "db">,
  extra: Partial<IdempotencyOptions> = {},
) {
  const logger = recordingLogger();
  const instance = createIdempotency({
    db: target.db,
    table: idempotencyKeys,
    secret: TEST_SECRET,
    logger,
    ...extra,
  });
  return Object.assign(instance, { logger });
}

function post(
  key: string | null,
  body: string,
  { path = "/orders", method = "POST" }: { path?: string; method?: string } = {},
): Request {
  return new Request(`https://api.example.test${path}`, {
    method,
    headers: key === null ? {} : { "Idempotency-Key": key },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const created = (body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status: 201, headers });

async function rowCount(scope: string): Promise<number> {
  const [row] = await database.current.rows<{ n: number }>(
    sql`select count(*)::int as n from ${idempotencyKeys} where scope = ${scope}`,
  );
  return row?.n ?? -1;
}

describe("must-pass", () => {
  test("concurrent duplicates: the handler runs once", async () => {
    const db = database.current;
    const instances = [
      idempotencyOn(db),
      idempotencyOn(db.connect({ max: 10 })),
      idempotencyOn(db.connect({ max: 10 })),
    ];
    const key = unique("order-key");
    const gate = deferred();
    let runs = 0;
    const handler = async () => {
      runs++;
      await gate.promise;
      return created({ order: "ord_1" }, { Location: "/orders/ord_1" });
    };

    let answered = 0;
    const requests = Array.from({ length: 30 }, (_, i) =>
      (instances[i % 3] as (typeof instances)[number])
        .handle(post(key, '{"sku":"A1"}'), { scope: "user:race" }, handler)
        .then((response) => {
          answered++;
          return response;
        }),
    );
    // The first request holds the key; every duplicate gets 409 while it runs.
    await waitUntil(() => answered === 29);
    gate.resolve();
    const responses = await Promise.all(requests);

    expect(runs).toBe(1);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, ...Array(29).fill(409)]);
    const conflict = responses.find((r) => r.status === 409) as Response;
    expect(conflict.headers.get("retry-after")).toBe("1");
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_key_in_use",
    );
    // Retrying now replays the stored response, from any instance.
    for (const instance of instances) {
      const replay = await instance.handle(
        post(key, '{"sku":"A1"}'),
        { scope: "user:race" },
        handler,
      );
      expect([
        replay.status,
        await replay.json(),
        replay.headers.get("idempotent-replayed"),
      ]).toEqual([201, { order: "ord_1" }, "true"]);
    }
    expect(runs).toBe(1);
    for (const instance of instances) expect(instance.logger.lines).toEqual([]);
  });

  test("concurrent duplicates that retry on 409 all end with the one response", async () => {
    const db = database.current;
    const instances = [
      idempotencyOn(db.connect({ max: 10 })),
      idempotencyOn(db.connect({ max: 10 })),
    ];
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => {
      const n = ++runs;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return created({ run: n });
    };
    const client = async (i: number) => {
      for (;;) {
        const instance = instances[i % 2] as (typeof instances)[number];
        const response = await instance.handle(post(key, "{}"), { scope: "user:retry" }, handler);
        if (response.status !== 409) return response;
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
      }
    };
    const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => client(i)));
    expect(runs).toBe(1);
    for (const response of responses) {
      expect([response.status, await response.json()]).toEqual([201, { run: 1 }]);
    }
    expect(responses.filter((r) => r.headers.get("idempotent-replayed") === null)).toHaveLength(1);
  });

  test("concurrent run() calls with one key run the function once", async () => {
    const db = database.current;
    const instances = [
      idempotencyOn(db.connect({ max: 10 })),
      idempotencyOn(db.connect({ max: 10 })),
    ];
    const key = unique("evt");
    let runs = 0;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        (instances[i % 2] as (typeof instances)[number]).run({ scope: "stripe", key }, async () => {
          runs++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { fulfilled: true };
        }),
      ),
    );
    expect(runs).toBe(1);
    const executed = results.filter((r) => r.ok && !r.replayed);
    expect(executed).toHaveLength(1);
    expect(
      results.every((r) => (r.ok ? r.value.fulfilled === true : r.reason === "in_progress")),
    ).toBe(true);
  });

  test("replay returns the same status and body", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => {
      runs++;
      return Response.json(
        { id: "ord_1", total: 4200, note: "héllo wörld" },
        {
          status: 201,
          statusText: "Created",
          headers: {
            Location: "/orders/ord_1",
            "X-Request-Id": "req-1",
            "Set-Cookie": "session=s3cr3t; HttpOnly",
          },
        },
      );
    };
    const first = await idempotency.handle(post(key, '{"sku":"A1"}'), { scope: "user:1" }, handler);
    const replay = await idempotency.handle(
      post(key, '{"sku":"A1"}'),
      { scope: "user:1" },
      handler,
    );

    expect(runs).toBe(1);
    expect([first.status, first.statusText, replay.status, replay.statusText]).toEqual([
      201,
      "Created",
      201,
      "Created",
    ]);
    const firstBody = await first.text();
    expect(await replay.text()).toBe(firstBody);
    expect(JSON.parse(firstBody)).toEqual({ id: "ord_1", total: 4200, note: "héllo wörld" });
    for (const name of ["content-type", "location", "x-request-id"]) {
      expect([name, replay.headers.get(name)]).toEqual([name, first.headers.get(name)]);
    }
    // The first response keeps its cookie; the stored copy never had it.
    expect(first.headers.get("set-cookie")).toBe("session=s3cr3t; HttpOnly");
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
  });

  test("the TTL expires", async () => {
    const clock = createTestClock(T0);
    const idempotency = idempotencyOn(database.current, { clock, ttl: "1h" });
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => created({ run: ++runs });
    const send = (body = "{}") =>
      idempotency.handle(post(key, body), { scope: "user:ttl" }, handler);

    expect(await (await send()).json()).toEqual({ run: 1 });
    clock.advance("59m");
    expect(await (await send()).json()).toEqual({ run: 1 });
    expect((await send('{"other":true}')).status).toBe(422);
    clock.advance("1m");
    const again = await send('{"other":true}');
    expect([again.status, await again.json(), again.headers.get("idempotent-replayed")]).toEqual([
      201,
      { run: 2 },
      null,
    ]);
    expect(runs).toBe(2);

    // A per-request ttl overrides the module's.
    const short = unique("order-key");
    const once = () =>
      idempotency.handle(post(short, "{}"), { scope: "user:ttl", ttl: "5m" }, handler);
    expect(await (await once()).json()).toEqual({ run: 3 });
    clock.advance("4m");
    expect(await (await once()).json()).toEqual({ run: 3 });
    clock.advance("1m");
    expect(await (await once()).json()).toEqual({ run: 4 });
  });
});

describe("handle", () => {
  test("rejects a key reused for a different body, path or method with 422", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => created({ run: ++runs });
    const scope = { scope: "user:422" };
    await idempotency.handle(post(key, '{"sku":"A1"}'), scope, handler);

    for (const request of [
      post(key, '{"sku":"B2"}'),
      post(key, '{"sku":"A1"}', { path: "/refunds" }),
      post(key, '{"sku":"A1"}', { path: "/orders?dry_run=1" }),
      post(key, '{"sku":"A1"}', { method: "PUT" }),
    ]) {
      const response = await idempotency.handle(request, scope, handler);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: {
          code: "idempotency_key_reused",
          message: "This Idempotency-Key was already used for a different request.",
        },
      });
    }
    expect(runs).toBe(1);
  });

  test("keeps scopes apart: the same key in another scope is a new request", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => created({ run: ++runs });
    const a = await idempotency.handle(post(key, "{}"), { scope: "user:a" }, handler);
    const b = await idempotency.handle(post(key, '{"different":1}'), { scope: "user:b" }, handler);
    expect([await a.json(), await b.json()]).toEqual([{ run: 1 }, { run: 2 }]);
  });

  test("leaves the body readable for the handler, or fingerprints what you pass", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("order-key");
    const request = post(key, '{"sku":"A1"}');
    const response = await idempotency.handle(request, { scope: "user:body" }, async () =>
      created(await request.json()),
    );
    expect(await response.json()).toEqual({ sku: "A1" });

    // Already parsed and validated: fingerprint the input instead of the raw body.
    const parsedKey = unique("order-key");
    const send = async (raw: string) => {
      const input = post(parsedKey, raw);
      const parsed = (await input.json()) as { sku: string };
      return idempotency.handle(
        input,
        { scope: "user:body", fingerprint: JSON.stringify({ sku: parsed.sku }) },
        async () => created(parsed),
      );
    };
    expect((await send('{"sku":"A1"}')).status).toBe(201);
    // Whitespace differs, the input doesn't: a replay, not a mismatch.
    const replay = await send('{ "sku": "A1" }');
    expect([replay.status, replay.headers.get("idempotent-replayed")]).toEqual([201, "true"]);
    expect((await send('{"sku":"B2"}')).status).toBe(422);
  });

  test("replays binary bodies, 204s and redirects exactly", async () => {
    const idempotency = idempotencyOn(database.current);
    const cases: [string, () => Response][] = [
      [
        "binary",
        () =>
          new Response(new Uint8Array([0, 255, 128, 10]), {
            headers: { "Content-Type": "application/octet-stream" },
          }),
      ],
      ["empty", () => new Response(null, { status: 204 })],
      [
        "redirect",
        () => new Response(null, { status: 303, headers: { Location: "/orders/ord_1" } }),
      ],
    ];
    for (const [label, make] of cases) {
      const key = unique(`key-${label}`);
      let runs = 0;
      const handler = () => {
        runs++;
        return make();
      };
      const first = await idempotency.handle(post(key, label), { scope: "user:kinds" }, handler);
      const replay = await idempotency.handle(post(key, label), { scope: "user:kinds" }, handler);
      expect([label, runs, replay.status, replay.headers.get("location")]).toEqual([
        label,
        1,
        first.status,
        first.headers.get("location"),
      ]);
      expect([...new Uint8Array(await replay.arrayBuffer())]).toEqual([
        ...new Uint8Array(await first.arrayBuffer()),
      ]);
    }
  });

  test("doesn't store errors, so the client can retry with the same key", async () => {
    const idempotency = idempotencyOn(database.current);
    const scope = unique("user");
    const outcomes: (() => Response)[] = [
      () => {
        throw new Error("boom");
      },
      () => Response.json({ error: "down" }, { status: 503 }),
      () => Response.json({ error: "bad" }, { status: 400 }),
      () => Response.json({ error: "slow down" }, { status: 429 }),
      () => created({ ok: true }),
    ];
    const key = unique("order-key");
    let runs = 0;
    const handler = () => (outcomes[runs++] as () => Response)();

    await expect(idempotency.handle(post(key, "{}"), { scope }, handler)).rejects.toThrow("boom");
    expect(await rowCount(scope)).toBe(0);
    for (const status of [503, 400, 429]) {
      const response = await idempotency.handle(post(key, "{}"), { scope }, handler);
      expect(response.status).toBe(status);
      expect(await rowCount(scope)).toBe(0);
    }
    expect((await idempotency.handle(post(key, "{}"), { scope }, handler)).status).toBe(201);
    expect((await idempotency.handle(post(key, "{}"), { scope }, handler)).status).toBe(201);
    expect(runs).toBe(5);
    expect(await rowCount(scope)).toBe(1);
  });

  test("a crashed request frees its key once its lease runs out", async () => {
    const clock = createTestClock(T0);
    const db = database.current;
    const crashed = idempotencyOn(db.connect(), { clock, lease: "30s" });
    const rescuer = idempotencyOn(db, { clock, lease: "30s" });
    const key = unique("order-key");
    const stuck = deferred<Response>();
    let started = false;

    const first = crashed.handle(post(key, "{}"), { scope: "user:crash" }, () => {
      started = true;
      return stuck.promise;
    });
    await waitUntil(() => started);
    expect(
      (await rescuer.handle(post(key, "{}"), { scope: "user:crash" }, () => created({}))).status,
    ).toBe(409);
    // Same key, other body, while the first is abandoned: still a mismatch.
    clock.advance("31s");
    expect(
      (await rescuer.handle(post(key, '{"x":1}'), { scope: "user:crash" }, () => created({})))
        .status,
    ).toBe(422);

    const takeover = await rescuer.handle(post(key, "{}"), { scope: "user:crash" }, () =>
      created({ by: "rescuer" }),
    );
    expect([takeover.status, await takeover.json()]).toEqual([201, { by: "rescuer" }]);

    // The original finally returns: its response still goes out, but it can't overwrite the key.
    stuck.resolve(created({ by: "crashed" }));
    expect(await (await first).json()).toEqual({ by: "crashed" });
    expect(crashed.logger.lines.map((line) => line.level)).toEqual(["warn"]);
    expect(crashed.logger.lines[0]?.message).toContain("lease ran out");
    const replay = await rescuer.handle(post(key, "{}"), { scope: "user:crash" }, () =>
      created({}),
    );
    expect(await replay.json()).toEqual({ by: "rescuer" });
  });

  test("renews the lease while a slow request runs", async () => {
    const db = database.current;
    const slow = idempotencyOn(db.connect(), { lease: "3s" });
    const other = idempotencyOn(db, { lease: "3s" });
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 4_500));
      return created({ slow: true });
    };
    const first = slow.handle(post(key, "{}"), { scope: "user:slow" }, handler);
    await new Promise((resolve) => setTimeout(resolve, 3_800));
    // Past the original lease, but it was renewed: still in progress, not taken over.
    expect((await other.handle(post(key, "{}"), { scope: "user:slow" }, handler)).status).toBe(409);
    expect((await first).status).toBe(201);
    const replay = await other.handle(post(key, "{}"), { scope: "user:slow" }, handler);
    expect([replay.status, replay.headers.get("idempotent-replayed"), runs]).toEqual([
      201,
      "true",
      1,
    ]);
    expect(slow.logger.lines).toEqual([]);
  }, 20_000);

  test("stores neither the raw key nor the request body", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("raw-key-visible");
    const scope = unique("user");
    await idempotency.handle(post(key, '{"card":"4242424242424242"}'), { scope }, async () =>
      created({ ok: true }, { "Set-Cookie": "session=s3cr3t" }),
    );
    const rows = await database.current.rows<Record<string, unknown>>(
      sql`select * from ${idempotencyKeys} where scope = ${scope}`,
    );
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    for (const secret of [key, "4242424242424242", "s3cr3t"]) expect(text).not.toContain(secret);
    expect(rows[0]?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rows[0]?.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([rows[0]?.locked_by, rows[0]?.locked_until]).toEqual([null, null]);
  });

  test("works with a prefixed table in another schema", async () => {
    const idempotency = idempotencyOn(database.current, { table: altIdempotencyKeys });
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => created({ run: ++runs });
    await idempotency.handle(post(key, "{}"), { scope: "user:alt" }, handler);
    const replay = await idempotency.handle(post(key, "{}"), { scope: "user:alt" }, handler);
    expect([runs, replay.headers.get("idempotent-replayed")]).toEqual([1, "true"]);
    const [row] = await database.current.rows<{ n: number }>(
      sql`select count(*)::int as n from groundwork_alt.alt_idempotency_keys`,
    );
    expect(row?.n).toBeGreaterThan(0);
  });
});

describe("run", () => {
  test("returns the stored JSON value on every call, the first included", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("evt");
    let runs = 0;
    const fn = async () => {
      runs++;
      return { at: new Date(T0), items: [1, undefined, 3], skip: undefined };
    };
    const first = await idempotency.run({ scope: "stripe", key }, fn);
    const second = await idempotency.run({ scope: "stripe", key }, fn);
    const expected = { at: "2026-01-01T00:00:00.000Z", items: [1, null, 3] };
    expect(first).toEqual({ ok: true, value: expected, replayed: false });
    expect(second).toEqual({ ok: true, value: expected, replayed: true });
    if (first.ok) {
      const at: string = first.value.at;
      expect(at).toBe(expected.at);
    }
    expect(runs).toBe(1);
  });

  test("reports a mismatch only when a fingerprint is given", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("evt");
    await idempotency.run({ scope: "orders", key, fingerprint: "order:1" }, () => 1);
    expect(
      await idempotency.run({ scope: "orders", key, fingerprint: "order:2" }, () => 2),
    ).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(
      await idempotency.run({ scope: "orders", key, fingerprint: "order:1" }, () => 3),
    ).toEqual({
      ok: true,
      value: 1,
      replayed: true,
    });

    const loose = unique("evt");
    await idempotency.run({ scope: "orders", key: loose }, () => "first");
    expect(await idempotency.run({ scope: "orders", key: loose }, () => "second")).toEqual({
      ok: true,
      value: "first",
      replayed: true,
    });
  });

  test("never mixes run() and handle() keys", async () => {
    const idempotency = idempotencyOn(database.current);
    const key = unique("shared-key");
    await idempotency.run({ scope: "user:mix", key }, () => "from run");
    const response = await idempotency.handle(post(key, "{}"), { scope: "user:mix" }, async () =>
      created({ from: "handle" }),
    );
    expect([response.headers.get("idempotent-replayed"), await response.json()]).toEqual([
      null,
      { from: "handle" },
    ]);
  });

  test("stores nothing when the function throws or returns something JSON can't hold", async () => {
    const idempotency = idempotencyOn(database.current);
    const scope = unique("jobs");
    await expect(
      idempotency.run({ scope, key: "k" }, () => Promise.reject(new Error("nope"))),
    ).rejects.toThrow("nope");
    let caught: unknown;
    try {
      await idempotency.run({ scope, key: "k" }, () => ({ big: 1n }));
    } catch (error) {
      caught = error;
    }
    expect(isGroundworkError(caught) && caught.code).toBe("invalid_argument");
    expect(await rowCount(scope)).toBe(0);
    expect(await idempotency.run({ scope, key: "k" }, () => "works")).toEqual({
      ok: true,
      value: "works",
      replayed: false,
    });
  });

  test("returns undefined and null results as stored", async () => {
    const idempotency = idempotencyOn(database.current);
    const scope = unique("void");
    const nothing = async () => {};
    expect(await idempotency.run({ scope, key: "a" }, nothing)).toEqual({
      ok: true,
      value: undefined,
      replayed: false,
    });
    expect(await idempotency.run({ scope, key: "a" }, nothing)).toEqual({
      ok: true,
      value: undefined,
      replayed: true,
    });
    expect(await idempotency.run({ scope, key: "b" }, () => null)).toMatchObject({ value: null });
  });
});

describe("cleanup", () => {
  test("deletes expired keys and abandoned ones, never a request still running", async () => {
    const clock = createTestClock(T0);
    const db = database.current;
    await db.rows(sql`delete from ${idempotencyKeys}`);
    const idempotency = idempotencyOn(db, { clock, ttl: "1h", lease: "30s" });

    await idempotency.run({ scope: "c", key: "done" }, () => 1);
    // A request that crashed at T0: its lease ends at T0+30s, its TTL at T0+1h.
    const crashed = deferred();
    const crashing = idempotency.run({ scope: "c", key: "crashed" }, () => crashed.promise);
    await waitUntil(async () => (await rowCount("c")) === 2);
    clock.advance("59m");
    await idempotency.run({ scope: "c", key: "fresh" }, () => 2);
    expect(await idempotency.cleanup()).toBe(0);

    clock.advance("1m");
    expect(await idempotency.cleanup()).toBe(2);
    expect(await rowCount("c")).toBe(1);
    crashed.resolve();
    await crashing;
  });

  test("deletes in batches until nothing expired is left", async () => {
    const clock = createTestClock(T0);
    const db = database.current;
    await db.rows(sql`delete from ${idempotencyKeys}`);
    await db.rows(sql`
      insert into ${idempotencyKeys} (key, scope, fingerprint, response, created_at, completed_at, expires_at)
      select 'bulk-' || n, 'bulk', 'f', '{}', ${new Date(T0).toISOString()}::timestamptz,
        ${new Date(T0).toISOString()}::timestamptz, ${new Date(T0 + 1_000).toISOString()}::timestamptz
      from generate_series(1, 12001) as n`);
    clock.advance("1s");
    expect(await idempotencyOn(db, { clock }).cleanup()).toBe(12_001);
    expect(await rowCount("bulk")).toBe(0);
  });
});

describe("createGroundwork", () => {
  test("gw.idempotency works and its cleanup runs as an hourly schedule", async () => {
    const db = database.current;
    const logger = recordingLogger();
    const gw = createGroundwork({
      db: db.db,
      tables: { idempotencyKeys, jobs, jobSchedules, rateLimits },
      secret: TEST_SECRET,
      logger,
      idempotency: { ttl: "2h" },
    });
    const key = unique("order-key");
    let runs = 0;
    const handler = async () => created({ run: ++runs });
    await gw.idempotency.handle(post(key, "{}"), { scope: "user:gw" }, handler);
    const replay = await gw.idempotency.handle(post(key, "{}"), { scope: "user:gw" }, handler);
    expect([runs, replay.headers.get("idempotent-replayed")]).toEqual([1, "true"]);

    const summary = await gw.jobs.runOnce();
    expect(summary.failed).toBe(0);
    const health = await gw.jobs.health();
    const names = health.schedules.map((s) => s.name).sort();
    expect(names).toEqual(["groundwork.idempotency-cleanup", "groundwork.rate-limit-cleanup"]);
    expect(logger.lines.filter((l) => l.level !== "info")).toEqual([]);
  });

  test("explains a missing table", () => {
    const gw = createGroundwork({ db: database.current.db, tables: {}, secret: TEST_SECRET });
    expect(() => gw.idempotency).toThrow(/idempotencyKeys table/);
  });
});
