// Drives the README quickstart app over HTTP, after creating a key the way step 5 says to.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { client } from "./http.mjs";

// Step 5's gw.apiKeys.create(), with the quickstart's namespace and scope.
const CREATE_KEY = [
  'import { drizzle } from "drizzle-orm/postgres-js";',
  'import { createGroundwork } from "groundwork";',
  'import { groundworkTables } from "groundwork/schema";',
  'import postgres from "postgres";',
  "const client = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });",
  "const gw = createGroundwork({",
  "  db: drizzle({ client }),",
  "  tables: groundworkTables(),",
  "  secret: process.env.GROUNDWORK_SECRET,",
  '  apiKeys: { namespace: "demo", scopes: { "notes:write": "Create notes" } },',
  "});",
  'const { key } = await gw.apiKeys.create({ name: "My CLI", scopes: ["notes:write"] });',
  "console.log(key);",
  "await client.end();",
].join("\n");

export async function runQuickstartChecks({ base, env, app }) {
  writeFileSync(join(app, "create-key.mjs"), CREATE_KEY);
  const key = execFileSync(process.execPath, ["create-key.mjs"], {
    cwd: app,
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).trim();
  assert.match(key, /^demo_/);

  const call = client(base);
  const note = (token, idempotencyKey, text = "Hello") =>
    call("/api/notes", {
      method: "POST",
      token,
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
      body: { text },
    });
  assert.equal((await note(undefined, "note-0001-abcdef")).status, 401);
  const first = await note(key, "note-0001-abcdef");
  assert.equal(first.status, 201, first.text);
  const retry = await note(key, "note-0001-abcdef");
  assert.deepEqual(
    [retry.status, retry.json, retry.headers.get("idempotent-replayed")],
    [201, first.json, "true"],
  );
  assert.equal((await note(key, "note-0001-abcdef", "Other")).status, 422);

  assert.equal((await call("/api/jobs")).status, 401);
  const run = await call("/api/jobs", { token: env.CRON_SECRET });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.failed, 0, run.text);

  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const audit = await sql`select action, metadata from gw_audit_log`;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "note.create");
    assert.equal(audit[0].metadata.id, first.json.id);
    const jobs = await sql`select status from gw_jobs where type = 'note.created'`;
    assert.deepEqual(
      jobs.map((job) => job.status),
      ["completed"],
    );
  } finally {
    await sql.end();
  }
}
