// Drives examples/next-app over HTTP: every module, through the routes a client would call.
import assert from "node:assert/strict";
import { client } from "./http.mjs";

export async function runExampleChecks({ base, env }) {
  const call = client(base);
  const admin = env.ADMIN_SECRET;

  const home = await call("/");
  assert.equal(home.status, 200);
  assert.match(home.text, /groundwork example/);

  // API keys: created by an admin, shown once.
  const newKey = (name, scopes, token = admin) =>
    call("/api/admin/keys", { method: "POST", token, body: { name, scopes } });
  assert.equal((await newKey("x", ["posts:read"], null)).status, 401);
  assert.equal((await newKey("x", ["posts:read"], "not-the-admin-secret")).status, 401);
  assert.equal((await newKey("", ["nope"])).status, 400);
  const writer = await newKey("writer", ["posts:read", "posts:write"]);
  const reader = await newKey("reader", ["posts:read"]);
  assert.equal(writer.status, 201, writer.text);
  assert.match(writer.json.key, /^demo_/);
  assert.equal(writer.headers.get("cache-control"), "no-store");

  // Verification: missing, bogus, wrong scope.
  const anonymous = await call("/api/posts");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
  assert.equal(anonymous.json.error.code, "missing");
  assert.equal((await call("/api/posts", { token: "demo_not_a_real_key" })).status, 401);
  const forbidden = await call("/api/posts", {
    method: "POST",
    token: reader.json.key,
    body: { title: "Nope" },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.error.code, "forbidden_scope");
  const empty = await call("/api/posts", { token: reader.json.key });
  assert.deepEqual([empty.status, empty.json.posts], [200, []]);
  // The key's own default limit (60 a minute) is reported on every response.
  assert.match(empty.headers.get("ratelimit") ?? "", /r=\d+/);

  // Idempotency: a retry gets the first response back, never a second post.
  const write = (key, body) =>
    call("/api/posts", {
      method: "POST",
      token: writer.json.key,
      headers: key === undefined ? {} : { "idempotency-key": key },
      body,
    });
  const first = await write("post-0001-abcdef", { title: "Hello", body: "World" });
  assert.equal(first.status, 201, first.text);
  assert.equal(first.headers.get("location"), `/api/posts/${first.json.post.id}`);
  const retry = await write("post-0001-abcdef", { title: "Hello", body: "World" });
  assert.deepEqual([retry.status, retry.json], [201, first.json]);
  assert.equal(retry.headers.get("idempotent-replayed"), "true");
  assert.equal(retry.headers.get("location"), first.headers.get("location"));
  const reused = await write("post-0001-abcdef", { title: "Something else" });
  assert.deepEqual([reused.status, reused.json.error.code], [422, "idempotency_key_reused"]);
  // A failed request isn't stored, so the client can fix it and retry with the same key.
  assert.equal((await write("post-0002-abcdef", { title: "" })).status, 400);
  assert.equal((await write("post-0002-abcdef", { title: "Fixed" })).status, 201);

  // Concurrent duplicates: the handler runs once; the rest are told to retry (409).
  const burst = await Promise.all(
    Array.from({ length: 8 }, () => write("post-0003-abcdef", { title: "Burst" })),
  );
  const fresh = burst.filter((r) => r.status === 201 && !r.headers.get("idempotent-replayed"));
  assert.equal(fresh.length, 1, burst.map((r) => r.status).join(","));
  assert.ok(burst.every((r) => r.status === 201 || r.status === 409));
  const settled = await write("post-0003-abcdef", { title: "Burst" });
  assert.deepEqual(settled.json, fresh[0].json);

  const listed = await call("/api/posts", { token: reader.json.key });
  assert.equal(listed.json.posts.length, 3);
  assert.ok(listed.json.posts.every((post) => post.announcedAt === null));

  // Jobs: enqueued with each post, run by the cron route.
  assert.equal((await call("/api/jobs", { token: "wrong-cron-secret-0123456789" })).status, 401);
  const run = await call("/api/jobs", { token: env.CRON_SECRET });
  assert.equal(run.status, 200, run.text);
  // Three announcements, plus the retention schedule and groundwork's two cleanups.
  assert.equal(run.json.failed, 0, run.text);
  assert.ok(run.json.completed >= 6, run.text);
  const announced = await call("/api/posts", { token: reader.json.key });
  assert.ok(
    announced.json.posts.every((post) => post.announcedAt !== null),
    announced.text,
  );
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true, health.text);
  assert.ok(health.json.schedules.some((schedule) => schedule.name === "retention"));

  // Audit: key creation, posts and announcements, with no key material anywhere.
  const audit = await call("/api/admin/audit", { token: admin });
  assert.equal(audit.status, 200);
  const count = (action) => audit.json.entries.filter((entry) => entry.action === action).length;
  assert.deepEqual(
    [count("api_key.create"), count("post.create"), count("post.announce")],
    [2, 3, 3],
  );
  assert.ok(!audit.text.includes(writer.json.key), "the raw key is never in the audit log");
  assert.equal((await call("/api/admin/audit")).status, 401);

  // Rate limiting: 20 writes a minute per key. Invalid bodies count too: the limit comes first.
  let limited = null;
  for (let i = 0; i < 25 && !limited; i++) {
    const response = await write(undefined, { title: "" });
    if (response.status === 429) limited = response;
    else assert.equal(response.status, 400, response.text);
  }
  assert.ok(limited, "the write limit was never reached");
  assert.equal(limited.json.error.code, "rate_limited");
  assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
  assert.match(limited.headers.get("ratelimit") ?? "", /"posts:write";r=0/);
}
