// JSON values must reach jsonb columns as JSON, whatever the driver does with jsonb parameters.
//
// postgres-js runs JSON.stringify on any parameter the server types as json or jsonb. Drizzle
// 0.45 switches that off on every postgres-js client it wraps; Drizzle 1.0 doesn't, so JSON that
// groundwork had already encoded was stored as a JSON string (or, inside jsonb functions, failed
// with "cannot extract elements from a scalar"). These tests put the client's own serializers back
// after Drizzle wrapped it, so they cover Drizzle 1.0's behaviour on any installed Drizzle. They
// always use postgres-js, the driver this is about, whatever GW_TEST_DRIVER says.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApiKeys } from "../../src/api-keys/index.ts";
import { createAuditLog, diff } from "../../src/audit/index.ts";
import { createJobs } from "../../src/jobs/index.ts";
import { apiKeys, auditLog, jobSchedules, jobs } from "../fixtures/schema.ts";
import { useTestDatabase } from "../support/database.ts";
import { TEST_SECRET } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();

let client: postgres.Sql;
let db: ReturnType<typeof drizzle>;

beforeAll(() => {
  client = postgres(database.current.url, { max: 2, onnotice: () => {} });
  const serializers = client.options.serializers;
  const own = { json: serializers[114], jsonb: serializers[3802] };
  db = drizzle({ client });
  if (own.json) serializers[114] = own.json;
  if (own.jsonb) serializers[3802] = own.jsonb;
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
});

/** `jsonb_typeof` of each expression, read through the harness's own connection. */
async function typesOf(query: SQL): Promise<Record<string, unknown>> {
  const [row] = await database.current.rows(query);
  if (!row) throw new Error("no row");
  return row;
}

test("the client JSON-encodes jsonb parameters itself, as it does under Drizzle 1.0", async () => {
  // Without this, the tests below would pass on a client that never double-encodes.
  const rows = await db.execute<{ type: string }>(
    sql`select jsonb_typeof(${JSON.stringify({ a: 1 })}::jsonb) as type`,
  );
  expect(rows[0]?.type).toBe("string");
});

describe("on a postgres-js client with its own JSON serializers", () => {
  test("API keys store scopes, IP and origin lists, and metadata as JSON", async () => {
    const keys = createApiKeys({
      db,
      table: apiKeys,
      secret: TEST_SECRET,
      namespace: "json",
      scopes: { "posts:read": "Read posts", "posts:write": "Write posts" },
      defaultRateLimit: null,
    });
    const { key, record } = await keys.create({
      name: "json",
      scopes: ["posts:read", "posts:write"],
      allowedIps: ["10.0.0.0/8"],
      allowedOrigins: ["https://app.example.com"],
      metadata: { plan: "pro", seats: [1, 2] },
    });
    expect(record.scopes).toEqual(["posts:read", "posts:write"]);
    expect(record.allowedIps).toEqual(["10.0.0.0/8"]);
    expect(record.allowedOrigins).toEqual(["https://app.example.com"]);
    expect(record.metadata).toEqual({ plan: "pro", seats: [1, 2] });

    const updated = await keys.update(record.id, { metadata: { plan: "team" } });
    expect(updated?.metadata).toEqual({ plan: "team" });
    expect(
      await typesOf(sql`select jsonb_typeof(metadata) as metadata, scopes from ${apiKeys}
        where id = ${record.id}::uuid`),
    ).toEqual({ metadata: "object", scopes: ["posts:read", "posts:write"] });

    const verified = await keys.verify(key, { scopes: ["posts:write"], ip: "10.1.2.3" });
    expect(verified.ok).toBe(true);
  });

  test("audit entries store changes and metadata as JSON objects", async () => {
    const audit = createAuditLog({
      db,
      table: auditLog,
      actions: ["post.update"],
      entityTypes: ["post"],
    });
    const changes = diff({ title: "a", tags: ["x"] }, { title: "b", tags: ["x", "y"] });
    const entry = await audit.record({
      actor: { type: "user", id: "u1" },
      action: "post.update",
      entity: { type: "post", id: "p1" },
      changes,
      metadata: { via: "api" },
    });
    expect(entry.changes).toEqual(changes);
    expect(entry.metadata).toEqual({ via: "api" });
    expect(
      await typesOf(sql`select jsonb_typeof(changes) as changes, jsonb_typeof(metadata) as metadata
        from ${auditLog} where id = ${entry.id}`),
    ).toEqual({ changes: "object", metadata: "object" });

    const page = await audit.query({ entity: { type: "post", id: "p1" } });
    expect(page.entries.map((found) => found.changes)).toEqual([changes]);
  });

  test("jobs store payloads and results as JSON, and handlers get the payload back", async () => {
    const queue = createJobs({ db, table: jobs, schedulesTable: jobSchedules });
    const seen: unknown[] = [];
    const echo = queue.define("json.echo", {
      run(payload: { n: number; tags: string[] }) {
        seen.push(payload);
        return { doubled: payload.n * 2, tags: payload.tags };
      },
    });
    const { id } = await echo.enqueue({ n: 2, tags: ["a", "b"] });
    await queue.runOnce();

    expect(seen).toEqual([{ n: 2, tags: ["a", "b"] }]);
    const job = await queue.get(id);
    expect(job?.status).toBe("completed");
    expect(job?.payload).toEqual({ n: 2, tags: ["a", "b"] });
    expect(job?.result).toEqual({ doubled: 4, tags: ["a", "b"] });
    expect(
      await typesOf(sql`select jsonb_typeof(payload) as payload, jsonb_typeof(result) as result
        from ${jobs} where id = ${id}::uuid`),
    ).toEqual({ payload: "object", result: "object" });
  });
});
