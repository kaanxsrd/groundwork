import { describe, expect, test } from "bun:test";
import type { SQLWrapper } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { decodeCursor, encodeCursor } from "../../src/audit/cursor.ts";
import { type AuditEvent, createAuditLog } from "../../src/audit/index.ts";
import { createGroundwork } from "../../src/index.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";
import { groundworkTables } from "../../src/schema/index.ts";
import { TEST_SECRET } from "../support/rate-limit-conformance.ts";

const { auditLog } = groundworkTables();

function recordingDb() {
  const calls: SQLWrapper[] = [];
  const execute = async (query: SQLWrapper) => {
    calls.push(query);
    return [];
  };
  return { calls, db: { execute } };
}

function errorOf(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (error) {
    if (isGroundworkError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a GroundworkError");
}

async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (isGroundworkError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a GroundworkError");
}

describe("createAuditLog options", () => {
  const db = { execute: async () => [] };
  test.each([
    ["no actions", { db, table: auditLog }, /actions must be a non-empty array/],
    ["empty actions", { db, table: auditLog, actions: [] }, /non-empty array/],
    ["a blank action", { db, table: auditLog, actions: [""] }, /Invalid actions entry ""/],
    ["a duplicate action", { db, table: auditLog, actions: ["a", "a"] }, /lists "a" twice/],
    ["empty entity types", { db, table: auditLog, actions: ["a"], entityTypes: [] }, /entityTypes/],
    [
      "a bad redact rule",
      { db, table: auditLog, actions: ["a"], redact: [""] },
      /Invalid redact rule/,
    ],
    ["no db", { table: auditLog, actions: ["a"] }, /db must be/],
    [
      "the wrong table",
      { db, table: pgTable("posts", { id: text("id") }), actions: ["a"] },
      /is not the auditLog table/,
    ],
  ])("rejects %s", (_, options, message) => {
    const error = errorOf(() => createAuditLog(options as never));
    expect(error.code).toBe("invalid_config");
    expect(error.message).toMatch(message);
  });
});

describe("record validation", () => {
  const actor = { type: "user", id: "u1" } as const;

  test("unknown actions and entity types are rejected before anything is sent", async () => {
    const { db, calls } = recordingDb();
    const audit = createAuditLog({
      db,
      table: auditLog,
      actions: ["post.update"],
      entityTypes: ["post"],
    });
    const unknownAction = await rejection(audit.record({ actor, action: "post.delete" as never }));
    expect(unknownAction).toEqual({
      code: "invalid_argument",
      message: 'Unknown audit action "post.delete": add it to actions.',
    });
    const unknownEntity = await rejection(
      audit.record({ actor, action: "post.update", entity: { type: "user" as never, id: 1 } }),
    );
    expect(unknownEntity.message).toBe('Unknown audit entity type "user": add it to entityTypes.');
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["no actor", { action: "a" }, /actor is required/],
    [
      "an actor without a type",
      { actor: { id: 1 }, action: "a" },
      /actor.type must be a non-empty string/,
    ],
    ["an entity without a type", { actor, action: "a", entity: { id: 1 } }, /entity.type/],
    [
      "an object as entity id",
      { actor, action: "a", entity: { type: "x", id: {} } },
      /entity.id must be a string or a number/,
    ],
    ["a number as summary", { actor, action: "a", summary: 1 }, /summary must be a string/],
    ["an array as changes", { actor, action: "a", changes: [1] }, /changes must be a plain object/],
    [
      "a string as metadata",
      { actor, action: "a", metadata: "x" },
      /metadata must be a plain object/,
    ],
    [
      "an invalid date",
      { actor, action: "a", occurredAt: new Date(Number.NaN) },
      /occurredAt must be a valid Date/,
    ],
    ["a number as ip", { actor, action: "a", ip: 127 }, /ip must be a string/],
  ])("rejects %s", async (_, event, message) => {
    const { db, calls } = recordingDb();
    const audit = createAuditLog({ db, table: auditLog, actions: ["a"] });
    const error = await rejection(audit.record(event as never));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  test("a bad event in recordMany sends nothing, and the message says which one", async () => {
    const { db, calls } = recordingDb();
    const audit = createAuditLog({ db, table: auditLog, actions: ["a"] });
    const error = await rejection(
      audit.recordMany([
        { actor, action: "a" },
        { actor, action: "a", summary: 5 as never },
      ]),
    );
    expect(error.message).toBe("events[1].summary must be a string.");
    expect(calls).toHaveLength(0);
    expect(await audit.recordMany([])).toEqual([]);
    expect(calls).toHaveLength(0);
    const tooMany = Array.from({ length: 1_001 }, () => ({ actor, action: "a" as const }));
    expect((await rejection(audit.recordMany(tooMany))).message).toMatch(/at most 1000 events/);
  });

  test("errors never echo the values they were given", async () => {
    const { db } = recordingDb();
    const audit = createAuditLog({ db, table: auditLog, actions: ["a"] });
    const secret = "sk_live_do_not_log";
    const messages = [
      (await rejection(audit.record({ actor, action: "a", summary: { secret } as never }))).message,
      (await rejection(audit.record({ actor, action: "a", changes: [secret] as never }))).message,
      (await rejection(audit.record({ actor, action: "a", ip: { secret } as never }))).message,
    ];
    for (const message of messages) expect(message).not.toContain(secret);
  });
});

describe("query validation", () => {
  test("rejects bad limits, orders, dates and cursors before querying", async () => {
    const { db, calls } = recordingDb();
    const audit = createAuditLog({ db, table: auditLog, actions: ["a"] });
    for (const limit of [0, 1_001, 1.5]) {
      expect((await rejection(audit.query({ limit }))).message).toMatch(/limit must be an integer/);
    }
    expect((await rejection(audit.query({ order: "up" as never }))).message).toMatch(
      /order must be/,
    );
    expect((await rejection(audit.query({ from: new Date("nope") }))).message).toMatch(
      /from must be a valid Date/,
    );
    expect((await rejection(audit.query({ cursor: "garbage" }))).message).toMatch(
      /Invalid audit cursor/,
    );
    const descCursor = encodeCursor({
      order: "desc",
      occurredAt: "2026-01-01T00:00:00.000000Z",
      id: 1,
    });
    expect((await rejection(audit.query({ order: "asc", cursor: descCursor }))).message).toMatch(
      /came from an "desc" query/,
    );
    expect(calls).toHaveLength(0);
  });

  test("cursors round-trip and reject anything tampered with", () => {
    const position = { order: "asc", occurredAt: "2026-01-01T00:00:00.123456Z", id: 42 } as const;
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    const forged = Buffer.from(JSON.stringify(["a1", "asc", "2026-01-01 00:00", 42])).toString(
      "base64url",
    );
    expect(() => decodeCursor(forged)).toThrow(/Invalid audit cursor/);
    expect(() => decodeCursor(Buffer.from("[]").toString("base64url"))).toThrow(
      /Invalid audit cursor/,
    );
  });

  test("prune needs a positive duration", async () => {
    const { db } = recordingDb();
    const audit = createAuditLog({ db, table: auditLog, actions: ["a"] });
    expect((await rejection(audit.prune({ olderThan: "0d" }))).message).toMatch(
      /Invalid olderThan/,
    );
    expect((await rejection(audit.prune(undefined as never))).message).toMatch(/prune needs/);
  });
});

describe("types", () => {
  test("actions and entity types are inferred from the config, without as const", () => {
    const { db } = recordingDb();
    const audit = createAuditLog({
      db,
      table: auditLog,
      actions: ["post.create", "post.update"],
      entityTypes: ["post"],
    });
    const ok: AuditEvent<"post.create" | "post.update", "post"> = {
      actor: { type: "user" },
      action: "post.create",
      entity: { type: "post", id: 1 },
    };
    const badAction: Parameters<typeof audit.record>[0] = {
      actor: { type: "user" },
      // @ts-expect-error not a declared action
      action: "post.delete",
    };
    const badEntity: Parameters<typeof audit.record>[0] = {
      actor: { type: "user" },
      action: "post.create",
      // @ts-expect-error not a declared entity type
      entity: { type: "user" },
    };
    // Type checks only; never called.
    // @ts-expect-error query filters are typed too
    const badQuery = () => audit.query({ action: "post.delete" });
    expect(typeof badQuery).toBe("function");
    expect([ok, badAction, badEntity]).toHaveLength(3);
    expect(audit.actions).toEqual(["post.create", "post.update"]);
  });

  test("createGroundwork infers them too, and gw.audit needs its config and table", () => {
    const { db } = recordingDb();
    const gw = createGroundwork({
      db,
      tables: { auditLog },
      secret: TEST_SECRET,
      audit: { actions: ["order.refund"], entityTypes: ["order"] },
    });
    const action: "order.refund" = gw.audit.actions[0] ?? "order.refund";
    // @ts-expect-error not a declared action
    const badRecord = () => gw.audit.record({ actor: { type: "system" }, action: "order.ship" });
    expect(typeof badRecord).toBe("function");
    expect(action).toBe("order.refund");
    expect(gw.audit).toBe(gw.audit);

    const noConfig = createGroundwork({ db, tables: { auditLog }, secret: TEST_SECRET });
    expect(() => noConfig.audit).toThrow(/gw.audit needs its actions/);
    const noTable = createGroundwork({
      db,
      tables: {},
      secret: TEST_SECRET,
      audit: { actions: ["a"] },
    });
    expect(() => noTable.audit).toThrow(/needs the auditLog table/);
  });
});
