// Runs in the smoke project under plain Node: migrates a fresh database with the SQL drizzle-kit
// generated from groundworkTables(), then rate-limits against it through the published API.
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createGroundwork } from "groundwork";
import { groundworkTables } from "groundwork/schema";
import postgres from "postgres";

const maintenanceUrl = process.env.SMOKE_DATABASE_URL;
const migrationsFolder = process.env.SMOKE_MIGRATIONS;
assert.ok(maintenanceUrl && migrationsFolder, "SMOKE_DATABASE_URL and SMOKE_MIGRATIONS are set");

const admin = postgres(maintenanceUrl, { max: 1, onnotice: () => {} });
const name = `gw_smoke_${Date.now().toString(36)}`;
await admin.unsafe(`create database "${name}"`);
try {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 4, onnotice: () => {} });
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder });

  const gw = createGroundwork({
    db,
    tables: groundworkTables(),
    secret: "smoke-test-secret-0123456789abcdefghij",
    audit: { actions: ["smoke.run"] },
    apiKeys: {
      namespace: "smk",
      scopes: { "posts:read": "Read posts", "posts:write": "Write posts" },
    },
  });
  const rule = gw.rateLimit.rule({ name: "smoke", limit: 2, window: "1m" });
  const results = await Promise.all([1, 2, 3, 4].map(() => rule.check("203.0.113.9")));
  assert.equal(results.filter((r) => r.allowed).length, 2);
  assert.ok(
    results.every((r) => r.degraded === false),
    "Postgres answered, not the fallback",
  );
  assert.match(results.find((r) => !r.allowed)?.headers["Retry-After"] ?? "", /^\d+$/);

  const [row] = await client`select used, key from gw_rate_limits`;
  assert.equal(row.used, 2);
  assert.notEqual(row.key, "203.0.113.9");

  // Audit: recorded inside a transaction, redacted before it reaches the table, read back.
  await db.transaction(async (tx) => {
    await gw.audit.record(
      {
        actor: { type: "system" },
        action: "smoke.run",
        metadata: { nested: { password: "p4ss" } },
      },
      { tx },
    );
  });
  const [stored] = await client`select metadata::text as metadata from gw_audit_log`;
  assert.ok(!stored.metadata.includes("p4ss"), "the password never reached the table");
  const { entries, nextCursor } = await gw.audit.query({ action: "smoke.run" });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].metadata, { nested: { password: "[redacted]" } });
  assert.equal(nextCursor, null);

  // API keys: created once, stored as a hash, verified from a Request, rejected with a JSON 403.
  const { key, record } = await gw.apiKeys.create({ name: "smoke", scopes: ["posts:read"] });
  assert.match(key, /^smk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}[0-9A-Za-z]{6}$/);
  const request = new Request("https://api.test/", { headers: { authorization: `Bearer ${key}` } });
  const ok = await gw.apiKeys.verify(request, { scopes: ["posts:read"] });
  assert.equal(ok.ok, true);
  const denied = await gw.apiKeys.verify(request, { scopes: ["posts:write"] });
  assert.equal(denied.ok, false);
  assert.equal(denied.response.status, 403);
  assert.deepEqual((await denied.response.json()).error.missingScopes, ["posts:write"]);
  const [keyRow] = await client`select row_to_json(k)::text as row from gw_api_keys k`;
  assert.ok(!keyRow.row.includes(key.slice(17, 40)), "the key itself is never stored");
  const [entry] = (await gw.audit.query({ action: "api_key.create" })).entries;
  assert.equal(entry.entity.id, record.id);
  await client.end();
} finally {
  await admin.unsafe(`drop database if exists "${name}" with (force)`);
  await admin.end();
}
