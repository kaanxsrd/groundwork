// Strings Postgres can't store: `\u0000` (refused by text and jsonb) and a lone surrogate (half of
// an emoji, refused by jsonb). They used to make the write throw, rolling back the caller's
// transaction; now they're stored with U+FFFD in their place. Results that can't be stored no
// longer make a successful job run again.
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createApiKeys } from "../../src/api-keys/index.ts";
import { createAuditLog } from "../../src/audit/index.ts";
import { createIdempotency } from "../../src/idempotency/index.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";
import { createJobs } from "../../src/jobs/index.ts";
import {
  apiKeys,
  auditLog,
  idempotencyKeys,
  jobSchedules,
  jobs as jobsTable,
} from "../fixtures/schema.ts";
import { useTestDatabase } from "../support/database.ts";
import { recordingLogger, TEST_SECRET, unique } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();
// What `"Ana 😀".slice(0, 5)` leaves: the first half of the emoji.
const HALF_EMOJI = "Ana 😀".slice(0, 5);
const NUL = "a\u0000b";
const R = "�";

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return isGroundworkError(error) ? error.code : `not a GroundworkError: ${String(error)}`;
  }
  return undefined;
}

function jobsWith(logger = recordingLogger()) {
  return {
    logger,
    jobs: createJobs({
      db: database.current.db,
      table: jobsTable,
      schedulesTable: jobSchedules,
      logger,
    }),
  };
}

describe("strings Postgres can't store", () => {
  test("an audit entry stores them in free text with U+FFFD, inside the caller's transaction", async () => {
    const audit = createAuditLog({ db: database.current.db, table: auditLog, actions: ["x.y"] });
    const requestId = unique("req");
    await database.current.db.transaction(async (tx) => {
      await audit.record(
        {
          actor: { type: "user", id: "u_1", label: HALF_EMOJI },
          action: "x.y",
          requestId,
          summary: `said ${NUL}`,
          changes: { name: [null, HALF_EMOJI] },
          metadata: { preview: NUL, [`k${NUL}`]: 1 },
        },
        { tx },
      );
    });
    const [entry] = (await audit.query({ requestId })).entries;
    expect(entry?.actor).toMatchObject({ id: "u_1", label: `Ana ${R}` });
    expect(entry?.summary).toBe(`said a${R}b`);
    expect(entry?.changes).toEqual({ name: [null, `Ana ${R}`] });
    expect(entry?.metadata).toEqual({ preview: `a${R}b`, [`ka${R}b`]: 1 });
  });

  test("identifiers with them are refused, in writes and in filters alike", async () => {
    // Cleaning an id could make two the same, and the original value would never find the row.
    const audit = createAuditLog({ db: database.current.db, table: auditLog, actions: ["x.y"] });
    const actor = { type: "user", id: "u_1" };
    const writes = [
      { actor: { type: "user", id: NUL }, action: "x.y" as const },
      { actor: { type: NUL }, action: "x.y" as const },
      { actor, action: "x.y" as const, entity: { type: NUL, id: "1" } },
      { actor, action: "x.y" as const, entity: { type: "post", id: HALF_EMOJI } },
      { actor, action: "x.y" as const, requestId: NUL },
      { actor, action: "x.y" as const, ip: NUL },
    ];
    for (const write of writes) {
      expect(await codeOf(() => audit.record(write))).toBe("invalid_argument");
    }
    for (const filter of [
      { actorId: NUL },
      { actorType: NUL },
      { entity: { type: "post", id: NUL } },
      { requestId: HALF_EMOJI },
    ]) {
      expect(await codeOf(() => audit.query(filter))).toBe("invalid_argument");
    }

    const keys = createApiKeys({
      db: database.current.db,
      table: apiKeys,
      secret: TEST_SECRET,
      namespace: "tst",
      scopes: { "a:read": "Read" },
      defaultRateLimit: null,
    });
    expect(await codeOf(() => keys.create({ name: "k", scopes: ["a:read"], ownerId: NUL }))).toBe(
      "invalid_argument",
    );
    expect(await codeOf(() => keys.list({ ownerId: NUL }))).toBe("invalid_argument");

    const idempotency = createIdempotency({
      db: database.current.db,
      table: idempotencyKeys,
      secret: TEST_SECRET,
    });
    expect(
      await codeOf(() => idempotency.run({ scope: `orders${NUL}`, key: unique("k") }, () => 1)),
    ).toBe("invalid_argument");
  });

  test("a job payload is enqueued with U+FFFD, and its handler gets that", async () => {
    const { jobs } = jobsWith();
    const seen: unknown[] = [];
    const type = unique("unstorable.payload");
    const handle = jobs.define(type, {
      run(payload: unknown) {
        seen.push(payload);
      },
    });
    await handle.enqueue({ name: HALF_EMOJI, note: NUL });
    await handle.enqueueMany([{ payload: { name: HALF_EMOJI } }]);
    expect(await jobs.runOnce()).toMatchObject({ completed: 2, failed: 0 });
    expect(seen).toContainEqual({ name: `Ana ${R}`, note: `a${R}b` });
    expect(seen).toContainEqual({ name: `Ana ${R}` });
  });

  test("a handler's result with them is stored with U+FFFD, and the job runs once", async () => {
    const { jobs } = jobsWith();
    let runs = 0;
    const type = unique("unstorable.result");
    const handle = jobs.define(type, {
      maxAttempts: 3,
      run() {
        runs++;
        return { name: HALF_EMOJI, note: NUL };
      },
    });
    const { id } = await handle.enqueue({});
    expect(await jobs.runOnce()).toMatchObject({ completed: 1, retried: 0, failed: 0 });
    expect(runs).toBe(1);
    expect((await jobs.get(id))?.result).toEqual({ name: `Ana ${R}`, note: `a${R}b` });
  });

  test("a result that can't be serialized is stored as null, and the job still runs once", async () => {
    const { jobs, logger } = jobsWith();
    let runs = 0;
    let exhausted = 0;
    const type = unique("unserializable.result");
    const handle = jobs.define(type, {
      maxAttempts: 3,
      run() {
        runs++;
        return {
          toJSON() {
            throw new Error("not serializable");
          },
        };
      },
      onExhausted() {
        exhausted++;
      },
    });
    const { id } = await handle.enqueue({});
    expect(await jobs.runOnce()).toMatchObject({ completed: 1, retried: 0, failed: 0 });
    expect([runs, exhausted]).toEqual([1, 0]);
    expect(await jobs.get(id)).toMatchObject({ status: "completed", result: null });
    expect(logger.lines.map((line) => line.message)).toContainEqual(
      expect.stringContaining("its result can't be stored"),
    );
  });

  test("an error message with \\u0000 is stored as the job's last error", async () => {
    const { jobs } = jobsWith();
    const type = unique("unstorable.error");
    const handle = jobs.define(type, {
      maxAttempts: 1,
      run() {
        throw new Error(`bad ${NUL}`);
      },
    });
    const { id } = await handle.enqueue({});
    expect(await jobs.runOnce()).toMatchObject({ failed: 1 });
    expect(await jobs.get(id)).toMatchObject({ status: "failed", lastError: `Error: bad a${R}b` });
  });

  test("a dedupeKey with them is refused: two keys must never become one", async () => {
    const { jobs } = jobsWith();
    const handle = jobs.define(unique("unstorable.key"), { run() {} });
    for (const dedupeKey of [NUL, HALF_EMOJI]) {
      const error = await handle.enqueue({}, { dedupeKey }).catch((thrown: unknown) => thrown);
      expect(isGroundworkError(error) && error.code).toBe("invalid_argument");
    }
  });

  test("an API key stores them in its name, metadata and revoke reason", async () => {
    const keys = createApiKeys({
      db: database.current.db,
      table: apiKeys,
      secret: TEST_SECRET,
      namespace: "tst",
      scopes: { "a:read": "Read" },
      defaultRateLimit: null,
    });
    const { record } = await keys.create({
      name: `shop ${NUL}`,
      scopes: ["a:read"],
      metadata: { preview: HALF_EMOJI },
    });
    expect(record).toMatchObject({ name: `shop a${R}b`, metadata: { preview: `Ana ${R}` } });
    expect(await keys.revoke(record.id, { reason: `stolen ${NUL}` })).not.toBeNull();
    const [row] = await database.current.rows<{ revoked_reason: string }>(
      sql`select revoked_reason from ${apiKeys} where id = ${record.id}::uuid`,
    );
    expect(row?.revoked_reason).toBe(`stolen a${R}b`);
  });
});
