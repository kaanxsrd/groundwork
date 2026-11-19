import { beforeAll, describe, expect, test } from "bun:test";
import { eq, or, sql } from "drizzle-orm";
import { type AuditEvent, createAuditLog, diff, REDACTED } from "../../src/audit/index.ts";
import { createGroundwork } from "../../src/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { altAuditLog, auditLog } from "../fixtures/schema.ts";
import { createTestDatabase, type TestDatabase, useTestDatabase } from "../support/database.ts";
import { TEST_SECRET, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();

const ACTIONS = [
  "post.create",
  "post.update",
  "order.refund",
  "payment.capture",
  "shipment.create",
  "user.login",
] as const;
const ENTITIES = ["post", "order", "payment", "shipment", "user"] as const;
type Action = (typeof ACTIONS)[number];
type Entity = (typeof ENTITIES)[number];

const auditFor = (
  target: Pick<TestDatabase, "db">,
  extra: { clock?: ReturnType<typeof createTestClock> } = {},
) =>
  createAuditLog({
    db: target.db,
    table: auditLog,
    actions: ACTIONS,
    entityTypes: ENTITIES,
    ...extra,
  });

const event = (
  overrides: Partial<AuditEvent<Action, Entity>> = {},
): AuditEvent<Action, Entity> => ({
  actor: { type: "user", id: "u1", label: "ada@example.com" },
  action: "post.update",
  entity: { type: "post", id: "p1" },
  ...overrides,
});

// A table of the app's own, to show audit entries commit and roll back with business changes.
beforeAll(async () => {
  await database.current.db.execute(
    sql`create table posts (id text primary key, title text not null, password text)`,
  );
});

describe("record", () => {
  test("stores the event and returns it as stored", async () => {
    const audit = auditFor(database.current);
    const before = Date.now();
    const entry = await audit.record({
      actor: { type: "user", id: 42, label: "ada@example.com" },
      action: "post.create",
      entity: { type: "post", id: 7 },
      summary: 'Created post "Hello"',
      changes: diff(null, { title: "Hello", publishedAt: new Date("2026-01-01T00:00:00Z") }),
      metadata: { userAgent: "Mozilla/5.0", emoji: "✓ ünïcode" },
      ip: "203.0.113.7",
      requestId: "req_1",
    });
    expect(entry).toMatchObject({
      actor: { type: "user", id: "42", label: "ada@example.com" },
      action: "post.create",
      entity: { type: "post", id: "7" },
      summary: 'Created post "Hello"',
      changes: { title: [null, "Hello"], publishedAt: [null, "2026-01-01T00:00:00.000Z"] },
      metadata: { userAgent: "Mozilla/5.0", emoji: "✓ ünïcode" },
      ip: "203.0.113.7",
      requestId: "req_1",
    });
    expect(Number.isSafeInteger(entry.id)).toBe(true);
    expect(entry.occurredAt.getTime()).toBeGreaterThan(before - 5_000);
    expect(entry.occurredAt.getTime()).toBeLessThan(Date.now() + 5_000);
  });

  test("optional fields default to null, and an actor can be the system", async () => {
    const entry = await auditFor(database.current).record({
      actor: { type: "system" },
      action: "user.login",
    });
    expect(entry).toMatchObject({
      actor: { type: "system", id: null, label: null },
      entity: null,
      summary: null,
      changes: null,
      metadata: null,
      ip: null,
      requestId: null,
    });
  });

  test("a record inside a rolled-back transaction disappears with the change", async () => {
    const { db } = database.current;
    const audit = auditFor(database.current);
    const requestId = unique("rollback");
    const rollback = new Error("roll back");
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`insert into posts (id, title) values (${requestId}, 'draft')`);
        await audit.record(event({ action: "post.create", requestId }), { tx });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await audit.count({ requestId })).toBe(0);
    expect(
      await database.current.rows(sql`select 1 from posts where id = ${requestId}`),
    ).toHaveLength(0);
  });

  test("a committed one stays, stamped with the transaction's time", async () => {
    const { db } = database.current;
    const audit = auditFor(database.current);
    const requestId = unique("commit");
    const same = await db.transaction(async (tx) => {
      await tx.execute(sql`insert into posts (id, title) values (${requestId}, 'live')`);
      const entry = await audit.record(event({ requestId }), { tx });
      const result = await tx.execute(
        sql`select (select occurred_at from ${auditLog} where id = ${entry.id}) = now() as same`,
      );
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows)[0];
    });
    expect(same).toEqual({ same: true });
    expect(await audit.count({ requestId })).toBe(1);
  });

  test("uses the injected clock, or an explicit occurredAt for imported entries", async () => {
    const clock = createTestClock("2030-05-05T05:05:05.000Z");
    const audit = auditFor(database.current, { clock });
    expect((await audit.record(event())).occurredAt.toISOString()).toBe("2030-05-05T05:05:05.000Z");
    const imported = await audit.record(
      event({ occurredAt: new Date("2019-01-01T12:00:00.123Z") }),
    );
    expect(imported.occurredAt.toISOString()).toBe("2019-01-01T12:00:00.123Z");
  });

  test("redacts configured keys in nested changes and metadata before they reach the database", async () => {
    const { db } = database.current;
    const audit = createAuditLog({
      db,
      table: auditLog,
      actions: ACTIONS,
      redact: ["iban"],
    });
    const requestId = unique("redact");
    await audit.record(
      event({
        requestId,
        changes: diff(
          { title: "a", password: "old-pass-123" },
          { title: "b", password: "new-pass-456" },
        ),
        metadata: {
          billing: { customer: { iban: "DK5000400440116243", name: "Ada" } },
          headers: [{ authorization: "Bearer eyJhbGciOi" }, { accept: "*/*" }],
          oauth: { refresh_token: "rt_secret", scope: "read" },
        },
      }),
    );
    const [stored] = await database.current.rows<{ changes: string; metadata: string }>(
      sql`select changes::text as changes, metadata::text as metadata from ${auditLog} where request_id = ${requestId}`,
    );
    const raw = JSON.stringify(stored);
    for (const secret of [
      "old-pass-123",
      "new-pass-456",
      "DK5000400440116243",
      "eyJhbGciOi",
      "rt_secret",
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(JSON.parse(stored?.changes ?? "{}")).toEqual({ title: ["a", "b"], password: REDACTED });
    expect(JSON.parse(stored?.metadata ?? "{}")).toEqual({
      billing: { customer: { iban: REDACTED, name: "Ada" } },
      headers: [{ authorization: REDACTED }, { accept: "*/*" }],
      oauth: { refresh_token: REDACTED, scope: "read" },
    });
  });

  test("recordMany stores all events in one statement, in order, sharing the transaction time", async () => {
    const audit = auditFor(database.current);
    const requestId = unique("many");
    const entries = await audit.recordMany(
      ["post.create", "post.update", "order.refund"].map((action) =>
        event({ action: action as Action, requestId }),
      ),
    );
    expect(entries.map((e) => e.action)).toEqual(["post.create", "post.update", "order.refund"]);
    expect(entries[0]!.id).toBeLessThan(entries[1]!.id);
    expect(new Set(entries.map((e) => e.occurredAt.getTime())).size).toBe(1);
  });

  test("the identity column refuses ids from outside", async () => {
    // execute() returns a thenable, not a Promise, so wrap it for expect().rejects.
    const insertWithId = async () =>
      database.current.db.execute(
        sql`insert into ${auditLog} (id, actor_type, action) values (1, 'user', 'post.create')`,
      );
    await expect(insertWithId()).rejects.toThrow();
  });
});

describe("query and count", () => {
  let own: TestDatabase;
  let audit: ReturnType<typeof auditFor>;
  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    own = await createTestDatabase();
    audit = auditFor(own);
    await audit.recordMany([
      event({
        action: "post.create",
        entity: { type: "post", id: "p1" },
        summary: "Created 50% off post",
        occurredAt: at("2026-01-01T10:00:00Z"),
      }),
      event({
        action: "post.update",
        entity: { type: "post", id: "p1" },
        summary: "Renamed post_one",
        occurredAt: at("2026-01-02T10:00:00Z"),
      }),
      event({
        actor: { type: "system" },
        action: "order.refund",
        entity: { type: "order", id: "o-100" },
        changes: { orderNumber: "BH-100" },
        occurredAt: at("2026-01-03T10:00:00Z"),
      }),
      event({
        actor: { type: "api_key", id: "k1", label: "CI deploy" },
        action: "payment.capture",
        entity: { type: "payment", id: "pay-9" },
        changes: { orderNumber: "BH-100" },
        requestId: "req-9",
        occurredAt: at("2026-01-04T10:00:00Z"),
      }),
      event({
        actor: { type: "user", id: "u2", label: "grace@example.com" },
        action: "shipment.create",
        entity: { type: "shipment", id: "s-1" },
        changes: { orderNumber: "BH-200" },
        occurredAt: at("2026-01-05T10:00:00Z"),
      }),
      event({
        actor: { type: "user", id: "u2", label: "grace@example.com" },
        action: "user.login",
        entity: null,
        occurredAt: at("2026-01-06T10:00:00Z"),
      }),
    ]);
  });

  const summaries = async (query: Parameters<typeof audit.query>[0]) =>
    (await audit.query(query)).entries.map((e) => e.action);

  test("returns newest first by default, oldest first with order: asc", async () => {
    expect(await summaries({})).toEqual([
      "user.login",
      "shipment.create",
      "payment.capture",
      "order.refund",
      "post.update",
      "post.create",
    ]);
    expect((await summaries({ order: "asc" }))[0]).toBe("post.create");
  });

  test("filters by action, actor, entity and request", async () => {
    expect(await summaries({ action: "post.update" })).toEqual(["post.update"]);
    expect(await summaries({ action: ["post.create", "user.login"] })).toEqual([
      "user.login",
      "post.create",
    ]);
    expect(await summaries({ action: [] })).toEqual([]);
    expect(await summaries({ actorType: "system" })).toEqual(["order.refund"]);
    expect(await summaries({ actorType: ["system", "api_key"] })).toEqual([
      "payment.capture",
      "order.refund",
    ]);
    expect(await summaries({ actorId: "u2" })).toEqual(["user.login", "shipment.create"]);
    expect(await summaries({ entity: { type: "post" } })).toEqual(["post.update", "post.create"]);
    expect(await summaries({ entity: { type: "post", id: "p1" } })).toHaveLength(2);
    expect(await summaries({ entity: { id: ["o-100", "pay-9"] } })).toEqual([
      "payment.capture",
      "order.refund",
    ]);
    expect(await summaries({ requestId: "req-9" })).toEqual(["payment.capture"]);
  });

  test("from is inclusive and to is exclusive", async () => {
    expect(
      await summaries({ from: at("2026-01-03T10:00:00Z"), to: at("2026-01-05T10:00:00Z") }),
    ).toEqual(["payment.capture", "order.refund"]);
  });

  test("search is case-insensitive across summary, entity id and actor label, and literal", async () => {
    expect(await summaries({ search: "RENAMED" })).toEqual(["post.update"]);
    expect(await summaries({ search: "pay-9" })).toEqual(["payment.capture"]);
    expect(await summaries({ search: "grace@" })).toEqual(["user.login", "shipment.create"]);
    // % and _ are matched literally, not as wildcards.
    expect(await summaries({ search: "50%" })).toEqual(["post.create"]);
    expect(await summaries({ search: "post_one" })).toEqual(["post.update"]);
    expect(await summaries({ search: "post_" })).toEqual(["post.update"]);
  });

  test("where adds any condition: bubblehouse-dk's order timeline", async () => {
    // Order events, plus payment and shipment events that mention the order in their changes.
    const timeline = await summaries({
      entity: { type: ["order", "payment", "shipment"] },
      where: or(
        eq(auditLog.entityId, "o-100"),
        sql`${auditLog.changes}->>'orderNumber' = ${"BH-100"}`,
      ),
    });
    expect(timeline).toEqual(["payment.capture", "order.refund"]);
  });

  test("count uses the same filters", async () => {
    expect(await audit.count()).toBe(6);
    expect(await audit.count({ actorId: "u2" })).toBe(2);
    expect(await audit.count({ search: "nothing like this" })).toBe(0);
  });

  test("pages with a cursor until nextCursor is null", async () => {
    const first = await audit.query({ limit: 4 });
    expect(first.entries).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = await audit.query({ limit: 4, cursor: first.nextCursor });
    expect(second.entries.map((e) => e.action)).toEqual(["post.update", "post.create"]);
    expect(second.nextCursor).toBeNull();
    expect((await audit.query({ limit: 6 })).nextCursor).toBeNull();
  });

  test("works with the table in another schema", async () => {
    const alt = createAuditLog({ db: own.db, table: altAuditLog, actions: ACTIONS });
    await alt.record(event());
    expect(await alt.count()).toBe(1);
    expect(await audit.count()).toBe(6);
  });
});

describe("pagination under concurrent inserts", () => {
  for (const order of ["desc", "asc"] as const) {
    test(`returns every existing entry exactly once while others are written (${order})`, async () => {
      const own = await createTestDatabase();
      try {
        const reader = auditFor(own);
        // 300 entries, including 100 written in one transaction: they share one occurred_at, so
        // only the id tie-breaker keeps them apart.
        await reader.recordMany(Array.from({ length: 100 }, () => event()));
        await own.db.transaction(async (tx) => {
          await reader.recordMany(
            Array.from({ length: 100 }, () => event()),
            { tx },
          );
        });
        await reader.recordMany(Array.from({ length: 100 }, () => event()));
        const existing = (
          await own.rows<{ id: string }>(sql`select id::text as id from ${auditLog}`)
        ).map((r) => Number(r.id));
        expect(existing).toHaveLength(300);

        // Another pool keeps writing, single entries and batches, the whole time we page.
        const writer = auditFor(own.connect({ max: 4 }));
        let writing = true;
        let written = 0;
        const writers = Array.from({ length: 3 }, async () => {
          while (writing) {
            await Promise.all([
              writer.record(event()),
              writer.recordMany([event(), event(), event()]),
            ]);
            written += 4;
          }
        });

        const seen: number[] = [];
        try {
          let cursor: string | null = null;
          let pages = 0;
          do {
            const page = await reader.query({ order, limit: 7, cursor });
            seen.push(...page.entries.map((entry) => entry.id));
            cursor = page.nextCursor;
            pages++;
            // Stop the writers partway, so an ascending walk can reach the end.
            if (pages === 30) writing = false;
          } while (cursor !== null);
        } finally {
          // Always stop the writers before the database goes away.
          writing = false;
          await Promise.all(writers);
        }

        expect(written).toBeGreaterThan(0);
        expect(new Set(seen).size).toBe(seen.length); // no duplicates
        const seenSet = new Set(seen);
        expect(existing.filter((id) => !seenSet.has(id))).toEqual([]); // no gaps

        // Strictly ordered by (occurred_at, id). Compared with Postgres's microseconds: the
        // entries' Dates only have milliseconds, and concurrent writers interleave within one.
        const exact = new Map(
          (
            await own.rows<{ id: string; at: string }>(
              sql`select id::text as id, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as at from ${auditLog}`,
            )
          ).map((row) => [Number(row.id), row.at]),
        );
        for (let i = 1; i < seen.length; i++) {
          const a = { at: exact.get(seen[i - 1]!) ?? "", id: seen[i - 1]! };
          const b = { at: exact.get(seen[i]!) ?? "", id: seen[i]! };
          const forward = b.at > a.at || (b.at === a.at && b.id > a.id);
          expect(order === "asc" ? forward : !forward).toBe(true);
        }
      } finally {
        await own.close();
      }
    }, 60_000);
  }
});

describe("prune", () => {
  test("deletes entries older than the cutoff, in batches, and nothing newer", async () => {
    const own = await createTestDatabase();
    try {
      const clock = createTestClock("2027-01-01T00:00:00Z");
      const audit = auditFor(own, { clock });
      await own.db.execute(sql`
        insert into ${auditLog} (occurred_at, actor_type, action)
        select '2025-06-01T00:00:00Z'::timestamptz + n * interval '1 second', 'system', 'user.login'
        from generate_series(1, 12000) n`);
      await audit.record(event({ occurredAt: new Date("2026-01-02T00:00:00Z") })); // inside the year
      await audit.record(event()); // now, by the clock

      expect(await audit.prune({ olderThan: "365d" })).toBe(12_000);
      expect(await audit.count()).toBe(2);
      expect(await audit.prune({ olderThan: "365d" })).toBe(0);
    } finally {
      await own.close();
    }
  }, 30_000);
});

describe("createGroundwork", () => {
  test("gw.audit records and queries with the app's actions", async () => {
    const gw = createGroundwork({
      db: database.current.db,
      tables: { auditLog },
      secret: TEST_SECRET,
      audit: { actions: ["invoice.send"], entityTypes: ["invoice"], redact: ["iban"] },
    });
    const requestId = unique("gw");
    await gw.audit.record({
      actor: { type: "system" },
      action: "invoice.send",
      entity: { type: "invoice", id: 1 },
      metadata: { iban: "DK50" },
      requestId,
    });
    const { entries } = await gw.audit.query({ requestId });
    expect(entries.map((e) => [e.action, e.metadata])).toEqual([
      ["invoice.send", { iban: REDACTED }],
    ]);
  });
});
