import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { type SQLWrapper, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { generateKey, hashKey } from "../../src/api-keys/format.ts";
import { createApiKeys } from "../../src/api-keys/index.ts";
import { createGroundwork } from "../../src/index.ts";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { apiKeys, auditLog, rateLimits } from "../fixtures/schema.ts";
import { useTestDatabase } from "../support/database.ts";
import { TEST_SECRET } from "../support/rate-limit-conformance.ts";

const database = useTestDatabase();
const SCOPES = {
  "posts:read": "Read posts",
  "posts:write": "Create and edit posts",
  "analytics:read": "Read analytics",
};
const dialect = new PgDialect();

function setup(extra: { defaultRateLimit?: null; legacyHash?: (key: string) => string } = {}) {
  const clock = createTestClock("2026-03-01T00:00:00.000Z");
  const pending: Promise<unknown>[] = [];
  const gw = createGroundwork({
    db: database.current.db,
    tables: { apiKeys, rateLimits, auditLog },
    secret: TEST_SECRET,
    clock,
    audit: { actions: ["post.create"] },
    apiKeys: { namespace: "tst", scopes: SCOPES, waitUntil: (p) => pending.push(p), ...extra },
  });
  return {
    clock,
    gw,
    keys: gw.apiKeys,
    /** Waits for background writes (lastUsedAt), as a serverless platform would. */
    flush: async () => {
      await Promise.all(pending.splice(0));
    },
  };
}

/** A database wrapper that counts and records every statement. */
function counting() {
  const statements: string[] = [];
  const db = {
    execute: (query: SQLWrapper) => {
      statements.push(dialect.sqlToQuery(query.getSQL()).sql);
      return database.current.db.execute(query);
    },
  };
  return { db, statements };
}

const bearer = (key: string, headers: Record<string, string> = {}) =>
  new Request("https://api.test/v1/posts", {
    headers: { authorization: `Bearer ${key}`, ...headers },
  });

describe("verify: every reason", () => {
  test("missing: no key at all", async () => {
    const { keys } = setup();
    for (const input of [new Request("https://api.test/"), null, undefined, new Headers()]) {
      const result = await keys.verify(input);
      expect(result).toMatchObject({ ok: false, reason: "missing", status: 401, key: null });
    }
    const result = await keys.verify(new Request("https://api.test/"));
    if (result.ok) throw new Error("expected a failure");
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await result.response.json()).toEqual({
      error: {
        code: "missing",
        message: "Send your API key in the Authorization header as a Bearer token.",
      },
    });
  });

  test("malformed: never reaches the database", async () => {
    const { db, statements } = counting();
    const keys = createApiKeys({
      db,
      table: apiKeys,
      secret: TEST_SECRET,
      namespace: "tst",
      scopes: SCOPES,
      defaultRateLimit: null,
    });
    const real = generateKey("tst", true).key;
    const typo = `${real.slice(0, 20)}${real[20] === "A" ? "B" : "A"}${real.slice(21)}`;
    for (const raw of ["garbage", generateKey("abc", true).key, typo, `${real}x`, "tst_"]) {
      expect(await keys.verify(bearer(raw))).toMatchObject({
        ok: false,
        reason: "malformed",
        status: 401,
        prefix: null,
      });
    }
    expect(statements).toEqual([]);
  });

  test("invalid: well-formed but unknown, in one round trip", async () => {
    const { db, statements } = counting();
    const keys = createApiKeys({
      db,
      table: apiKeys,
      secret: TEST_SECRET,
      namespace: "tst",
      scopes: SCOPES,
      defaultRateLimit: null,
    });
    const unknown = generateKey("tst", true);
    const result = await keys.verify(bearer(unknown.key));
    // The presented prefix (never the key) is there for logging failed attempts.
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      status: 401,
      prefix: `tst_${unknown.prefix}`,
    });
    if (!result.ok) expect(result.headers["WWW-Authenticate"]).toBe('Bearer error="invalid_token"');
    expect(statements).toHaveLength(1);
  });

  test("ok, then revoked", async () => {
    const { keys } = setup();
    const { key, record } = await keys.create({ name: "CI", scopes: ["posts:read"] });
    const ok = await keys.verify(bearer(key), { scopes: ["posts:read"] });
    expect(ok).toMatchObject({ ok: true, key: { id: record.id, status: "active" } });
    await keys.revoke(record.id, { reason: "leaked" });
    expect(await keys.verify(bearer(key))).toMatchObject({
      ok: false,
      reason: "revoked",
      status: 401,
      key: { id: record.id, status: "revoked", revokedReason: "leaked" },
    });
  });

  test("expired", async () => {
    const { keys, clock } = setup();
    const { key } = await keys.create({ name: "Short", scopes: [], expiresIn: "1h" });
    clock.advance(3_599_999);
    expect((await keys.verify(bearer(key))).ok).toBe(true);
    clock.advance(1);
    expect(await keys.verify(bearer(key))).toMatchObject({
      ok: false,
      reason: "expired",
      status: 401,
    });
  });

  test("suspended, until the suspension ends or is lifted", async () => {
    const { keys, clock } = setup();
    const { key, record } = await keys.create({ name: "Bot", scopes: [] });
    await keys.suspend(record.id, { for: "30m", reason: "abuse" });
    expect(await keys.verify(bearer(key))).toMatchObject({
      ok: false,
      reason: "suspended",
      status: 403,
      key: { suspendedReason: "abuse" },
    });
    clock.advance("30m");
    expect((await keys.verify(bearer(key))).ok).toBe(true);
    await keys.suspend(record.id, { for: "1d" });
    expect((await keys.verify(bearer(key))).ok).toBe(false);
    await keys.reinstate(record.id);
    expect((await keys.verify(bearer(key))).ok).toBe(true);
  });

  test("forbidden_scope: every required scope, exactly or by resource:*", async () => {
    const { keys } = setup();
    const reader = await keys.create({ name: "Reader", scopes: ["posts:read"] });
    const denied = await keys.verify(bearer(reader.key), { scopes: ["posts:read", "posts:write"] });
    expect(denied).toMatchObject({
      ok: false,
      reason: "forbidden_scope",
      status: 403,
      missingScopes: ["posts:write"],
    });
    if (denied.ok) throw new Error("expected a failure");
    expect(denied.headers["WWW-Authenticate"]).toBe(
      'Bearer error="insufficient_scope", scope="posts:write"',
    );
    const body = (await denied.response.json()) as { error: { missingScopes: string[] } };
    expect(body.error.missingScopes).toEqual(["posts:write"]);

    const editor = await keys.create({ name: "Editor", scopes: ["posts:*"] });
    expect(
      (await keys.verify(bearer(editor.key), { scopes: ["posts:read", "posts:write"] })).ok,
    ).toBe(true);
    expect(await keys.verify(bearer(editor.key), { scopes: ["analytics:read"] })).toMatchObject({
      reason: "forbidden_scope",
    });
    expect((await keys.verify(bearer(editor.key))).ok).toBe(true); // no scopes required
  });

  test("ip_denied: CIDR allowlists for IPv4 and IPv6", async () => {
    const { keys } = setup();
    const { key } = await keys.create({
      name: "Office",
      scopes: [],
      allowedIps: ["203.0.113.0/24", "2001:db8::/32"],
    });
    for (const ip of ["203.0.113.1", "203.0.113.255", "::ffff:203.0.113.9", "2001:db8:abcd::1"]) {
      expect([ip, (await keys.verify(bearer(key), { ip })).ok]).toEqual([ip, true]);
    }
    for (const ip of ["203.0.114.1", "198.51.100.7", "2001:db9::1", "not-an-ip", null]) {
      expect(await keys.verify(bearer(key), { ip })).toMatchObject({
        ok: false,
        reason: "ip_denied",
        status: 403,
      });
    }
    expect(await keys.verify(bearer(key))).toMatchObject({ reason: "ip_denied" }); // no IP given
  });

  test("origin_denied: browsers must come from an allowed origin", async () => {
    const { keys } = setup();
    const { key } = await keys.create({
      name: "Widget",
      scopes: [],
      allowedOrigins: ["https://app.example.com"],
    });
    expect((await keys.verify(bearer(key, { origin: "https://app.example.com" }))).ok).toBe(true);
    expect((await keys.verify(bearer(key, { origin: "HTTPS://APP.EXAMPLE.COM:443" }))).ok).toBe(
      true,
    );
    for (const origin of ["https://evil.example", "null", "https://app.example.com.evil.test"]) {
      expect(await keys.verify(bearer(key, { origin }))).toMatchObject({
        ok: false,
        reason: "origin_denied",
        status: 403,
      });
    }
    expect((await keys.verify(bearer(key))).ok).toBe(true); // servers send no Origin
    expect(await keys.verify(bearer(key), { origin: "https://evil.example" })).toMatchObject({
      reason: "origin_denied",
    });
  });

  test("rate_limited: each key has its own limit, with headers", async () => {
    const { keys, clock } = setup();
    const { key, record } = await keys.create({
      name: "Tight",
      scopes: [],
      rateLimit: { limit: 2, window: "1m" },
    });
    const other = await keys.create({
      name: "Other",
      scopes: [],
      rateLimit: { limit: 2, window: "1m" },
    });
    const first = await keys.verify(bearer(key));
    expect(first.ok && first.headers.RateLimit).toBe('"tst:key";r=1;t=60');
    expect((await keys.verify(bearer(key))).ok).toBe(true);
    const limited = await keys.verify(bearer(key));
    expect(limited).toMatchObject({
      ok: false,
      reason: "rate_limited",
      status: 429,
      key: { id: record.id },
    });
    if (limited.ok) throw new Error("expected a failure");
    expect(limited.headers["Retry-After"]).toBe("60");
    expect(limited.response.headers.get("retry-after")).toBe("60");
    expect((await keys.verify(bearer(other.key))).ok).toBe(true); // its own counter
    clock.advance("1m");
    expect((await keys.verify(bearer(key))).ok).toBe(true);
  });

  test("the default limit is 60 a minute", async () => {
    const { keys } = setup();
    const { key, record } = await keys.create({ name: "Default", scopes: [] });
    expect(record.rateLimit).toEqual({ limit: 60, window: "1m" });
    const results = await Promise.all(Array.from({ length: 61 }, () => keys.verify(bearer(key))));
    expect(results.filter((r) => r.ok)).toHaveLength(60);
  });

  test("quota_exceeded: a daily quota on top of the rate limit", async () => {
    const { keys, clock } = setup();
    const { key } = await keys.create({
      name: "Metered",
      scopes: [],
      rateLimit: null,
      dailyQuota: 3,
    });
    for (let i = 0; i < 3; i++) expect((await keys.verify(bearer(key))).ok).toBe(true);
    const over = await keys.verify(bearer(key));
    expect(over).toMatchObject({ ok: false, reason: "quota_exceeded", status: 429 });
    if (!over.ok) expect(over.headers["Retry-After"]).toBe("86400");
    clock.advance("1d");
    expect((await keys.verify(bearer(key))).ok).toBe(true);
  });

  test("accepts the key as X-API-Key, as Headers, or as a raw string", async () => {
    const { keys } = setup();
    const { key } = await keys.create({ name: "Any", scopes: [] });
    expect(
      (await keys.verify(new Request("https://api.test/", { headers: { "x-api-key": key } }))).ok,
    ).toBe(true);
    expect((await keys.verify(new Headers({ authorization: `Bearer ${key}` }))).ok).toBe(true);
    expect((await keys.verify(key)).ok).toBe(true);
  });
});

describe("rotation", () => {
  test("the old key works until the grace period ends, then fails", async () => {
    const { keys, clock } = setup();
    const created = await keys.create({ name: "Deploy", scopes: ["posts:write"] });
    const rotated = await keys.rotate(created.record.id, { grace: "1h" });
    if (!rotated) throw new Error("rotate returned null");
    expect(rotated.key).not.toBe(created.key);
    expect(rotated.record.prefix).not.toBe(created.record.prefix);
    expect(rotated.record.previousKeyExpiresAt?.toISOString()).toBe("2026-03-01T01:00:00.000Z");

    expect(await keys.verify(bearer(created.key))).toMatchObject({
      ok: true,
      key: { id: created.record.id },
    });
    expect((await keys.verify(bearer(rotated.key))).ok).toBe(true);
    clock.advance(3_599_999);
    expect((await keys.verify(bearer(created.key))).ok).toBe(true);
    clock.advance(1);
    expect(await keys.verify(bearer(created.key))).toMatchObject({ ok: false, reason: "invalid" });
    expect((await keys.verify(bearer(rotated.key))).ok).toBe(true);
  });

  test("grace 0s ends the old key at once, and a second rotation replaces the first", async () => {
    const { keys } = setup();
    const created = await keys.create({ name: "Now", scopes: [] });
    const now = await keys.rotate(created.record.id, { grace: "0s" });
    expect((await keys.verify(bearer(created.key))).ok).toBe(false);
    const again = await keys.rotate(created.record.id, { grace: "1h" });
    expect((await keys.verify(bearer(now?.key ?? ""))).ok).toBe(true); // now in its grace period
    expect((await keys.verify(bearer(again?.key ?? ""))).ok).toBe(true);
  });

  test("revoking during the grace period stops both keys", async () => {
    const { keys } = setup();
    const created = await keys.create({ name: "Leaked", scopes: [] });
    const rotated = await keys.rotate(created.record.id, { grace: "1h" });
    await keys.revoke(created.record.id);
    expect(await keys.verify(bearer(created.key))).toMatchObject({ reason: "invalid" });
    expect(await keys.verify(bearer(rotated?.key ?? ""))).toMatchObject({ reason: "revoked" });
    expect(await keys.rotate(created.record.id)).toBeNull();
  });
});

describe("storage and bookkeeping", () => {
  test("only the HMAC is stored, never the key", async () => {
    const { keys } = setup();
    const { key, record } = await keys.create({ name: "Secret", scopes: ["posts:read"] });
    const [row] = await database.current.rows<{ row: string; key_hash: string }>(
      sql`select row_to_json(k)::text as row, k.key_hash from ${apiKeys} k where k.id = ${record.id}::uuid`,
    );
    const secretPart = key.split("_").slice(2).join("_");
    expect(row?.row).not.toContain(secretPart.slice(0, 20));
    expect(row?.key_hash).toBe(hashKey(deriveSubkey(TEST_SECRET, "api-keys"), key.slice(0, -6)));
    expect(record.prefix).toBe(key.slice(0, 16));
    expect(JSON.stringify(record)).not.toContain(secretPart.slice(0, 20));
  });

  test("lastUsedAt and lastUsedIp are written at most once a minute per key", async () => {
    const { db, statements } = counting();
    const clock = createTestClock("2026-03-01T00:00:00.000Z");
    const pending: Promise<unknown>[] = [];
    const options = {
      db,
      table: apiKeys,
      secret: TEST_SECRET,
      namespace: "tst",
      scopes: SCOPES,
      defaultRateLimit: null,
      clock,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as const;
    const keys = createApiKeys(options);
    const flush = async () => Promise.all(pending.splice(0));
    const touches = () => statements.filter((s) => s.includes("last_used_at = ")).length;
    const { key, record } = await keys.create({ name: "Busy", scopes: [] });

    for (let i = 0; i < 5; i++) await keys.verify(bearer(key), { ip: "203.0.113.7" });
    await flush();
    expect(touches()).toBe(1);
    expect(await keys.get(record.id)).toMatchObject({
      lastUsedAt: new Date("2026-03-01T00:00:00.000Z"),
      lastUsedIp: "203.0.113.7",
    });

    // Another instance (no shared memory) sees the fresh timestamp on the row and skips it too.
    const otherInstance = createApiKeys(options);
    await otherInstance.verify(bearer(key), { ip: "198.51.100.1" });
    clock.advance("30s");
    await keys.verify(bearer(key), { ip: "198.51.100.1" });
    await flush();
    expect(touches()).toBe(1);

    clock.advance("31s");
    await keys.verify(bearer(key), { ip: "198.51.100.1" });
    await flush();
    expect(touches()).toBe(2);
    expect((await keys.get(record.id))?.lastUsedIp).toBe("198.51.100.1");
  });

  test("get, list, update and delete", async () => {
    const { keys, clock } = setup();
    const owner = `owner-${Date.now()}`;
    const a = await keys.create({
      name: "A",
      scopes: ["posts:read"],
      ownerId: owner,
      metadata: { team: "web" },
    });
    // Created a moment later, so "newest first" has a defined answer (equal times tie-break by id).
    clock.advance("1s");
    const b = await keys.create({ name: "B", scopes: [], ownerId: owner });
    await keys.revoke(b.record.id);

    expect(await keys.get(a.record.id)).toMatchObject({
      name: "A",
      metadata: { team: "web" },
      ownerId: owner,
    });
    expect(await keys.get("not-a-uuid")).toBeNull();
    expect(await keys.get("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect((await keys.list({ ownerId: owner })).map((k) => k.name)).toEqual(["B", "A"]);
    expect((await keys.list({ ownerId: owner, status: "active" })).map((k) => k.name)).toEqual([
      "A",
    ]);
    expect((await keys.list({ ownerId: owner, status: ["revoked"] })).map((k) => k.name)).toEqual([
      "B",
    ]);

    const updated = await keys.update(a.record.id, {
      name: "A2",
      scopes: ["posts:*"],
      allowedIps: ["10.0.0.0/8"],
      dailyQuota: 100,
    });
    expect(updated).toMatchObject({
      name: "A2",
      scopes: ["posts:*"],
      allowedIps: ["10.0.0.0/8"],
      dailyQuota: 100,
    });
    expect(updated?.rateLimit).toEqual({ limit: 60, window: "1m" }); // untouched
    await expect(keys.update(a.record.id, { scopes: ["users:read" as never] })).rejects.toThrow(
      /Unknown scope/,
    );
    await expect(keys.update(a.record.id, { expiresAt: new Date("2020-01-01") })).rejects.toThrow(
      /in the future/,
    );

    expect(await keys.delete(a.record.id)).toBe(false); // still active
    expect(await keys.delete(b.record.id)).toBe(true);
    expect(await keys.get(b.record.id)).toBeNull();
  });

  test("validates new keys", async () => {
    const { keys } = setup();
    await expect(keys.create({ name: "", scopes: [] })).rejects.toThrow(/name must be/);
    await expect(keys.create({ name: "x", scopes: ["nope" as never] })).rejects.toThrow(
      /Unknown scope "nope"/,
    );
    await expect(
      keys.create({ name: "x", scopes: [], allowedIps: ["10.0.0.1/8"] }),
    ).rejects.toThrow(/did you mean/);
    await expect(
      keys.create({ name: "x", scopes: [], allowedOrigins: ["example.com"] }),
    ).rejects.toThrow(/Invalid origin/);
    await expect(
      keys.create({ name: "x", scopes: [], rateLimit: { limit: 0, window: "1m" } }),
    ).rejects.toThrow(/rateLimit must be/);
    await expect(
      keys.create({ name: "x", scopes: [], expiresIn: "1d", expiresAt: new Date("2030-01-01") }),
    ).rejects.toThrow(/not both/);
  });
});

describe("audit log", () => {
  const entriesFor = async (gw: ReturnType<typeof setup>["gw"], id: string) =>
    (await gw.audit.query({ entity: { type: "api_key", id }, order: "asc" })).entries;

  test("every change to a key is recorded, naming the key but never revealing it", async () => {
    const { gw, keys } = setup();
    const actor = { type: "user", id: "u1", label: "ada@example.com" } as const;
    const { key, record } = await keys.create({ name: "CI", scopes: ["posts:read"] }, { actor });
    await keys.update(record.id, { scopes: ["posts:read", "posts:write"] }, { actor });
    const rotated = await keys.rotate(record.id, { grace: "1h", actor });
    await keys.suspend(record.id, { for: "1h", reason: "investigating", actor });
    await keys.reinstate(record.id, { actor });
    await keys.revoke(record.id, { reason: "done", actor });
    await keys.delete(record.id, { actor });

    const entries = await entriesFor(gw, record.id);
    expect(entries.map((e) => e.action)).toEqual([
      "api_key.create",
      "api_key.update",
      "api_key.rotate",
      "api_key.suspend",
      "api_key.reinstate",
      "api_key.revoke",
      "api_key.delete",
    ]);
    expect(entries[0]).toMatchObject({
      actor: { type: "user", id: "u1" },
      summary: `Created API key "CI" (${record.prefix})`,
    });
    expect(entries[1]?.changes).toEqual({
      scopes: [["posts:read"], ["posts:read", "posts:write"]],
    });
    expect(entries[5]?.summary).toBe(`Revoked API key "CI" (${rotated?.record.prefix}): done`);
    const logged = JSON.stringify(entries);
    for (const secret of [key, rotated?.key ?? "?"])
      expect(logged).not.toContain(secret.slice(17, 40));
  });

  test("a change in a rolled-back transaction leaves neither the change nor its entry", async () => {
    const { gw, keys } = setup();
    const { key, record } = await keys.create({ name: "Kept", scopes: [] });
    const rollback = new Error("roll back");
    await expect(
      database.current.db.transaction(async (tx) => {
        await keys.revoke(record.id, { tx, reason: "oops" });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await keys.verify(bearer(key))).ok).toBe(true);
    expect((await entriesFor(gw, record.id)).map((e) => e.action)).toEqual(["api_key.create"]);
  });
});

describe("keys from an older system", () => {
  test("verify with legacyHash, and move to groundwork's hash on first use", async () => {
    // A vante.app-style key: same format without a checksum, stored as HMAC(pepper, key).
    const legacyHash = (key: string) =>
      createHmac("sha256", "old-pepper-from-vante").update(key).digest("hex");
    const { body: legacyKey, prefix } = generateKey("tst", false);
    await database.current.db.execute(
      sql`insert into ${apiKeys} (name, prefix, key_hash, scopes) values ('Imported', ${prefix}, ${legacyHash(legacyKey)}, '{posts:read}')`,
    );

    const without = setup({ defaultRateLimit: null });
    expect(await without.keys.verify(bearer(legacyKey))).toMatchObject({
      ok: false,
      reason: "invalid",
    });

    const migrating = setup({ defaultRateLimit: null, legacyHash });
    expect(
      await migrating.keys.verify(bearer(legacyKey), { scopes: ["posts:read"] }),
    ).toMatchObject({
      ok: true,
      key: { name: "Imported" },
    });
    await migrating.flush();
    const [row] = await database.current.rows<{ key_hash: string }>(
      sql`select key_hash from ${apiKeys} where prefix = ${prefix}`,
    );
    expect(row?.key_hash).toBe(hashKey(deriveSubkey(TEST_SECRET, "api-keys"), legacyKey));
    // Upgraded: it now verifies without the legacy hash.
    expect((await without.keys.verify(bearer(legacyKey))).ok).toBe(true);
  });
});

describe("configuration", () => {
  test("a secret function hashes keys as the secret itself does", async () => {
    const plain = setup().keys;
    const lazy = createApiKeys({
      db: database.current.db,
      table: apiKeys,
      secret: () => TEST_SECRET,
      namespace: "tst",
      scopes: SCOPES,
      defaultRateLimit: null,
    });
    const { key } = await lazy.create({ name: "Lazy", scopes: ["posts:read"] });
    expect((await plain.verify(bearer(key))).ok).toBe(true);
  });

  test("the default per-key limit needs a rate limiter, unless it is turned off", () => {
    const base = { db: database.current.db, secret: TEST_SECRET } as const;
    const noLimiter = createGroundwork({
      ...base,
      tables: { apiKeys },
      apiKeys: { namespace: "tst", scopes: SCOPES },
    });
    expect(() => noLimiter.apiKeys).toThrow(/needs gw.rateLimit/);
    const optedOut = createGroundwork({
      ...base,
      tables: { apiKeys },
      apiKeys: { namespace: "tst", scopes: SCOPES, defaultRateLimit: null },
    });
    expect(optedOut.apiKeys.namespace).toBe("tst");
    expect(() => createGroundwork({ ...base, tables: {} }).apiKeys).toThrow(
      /needs its namespace and scopes/,
    );
  });

  test("scopes are typed from the config", () => {
    const { keys } = setup();
    // Type checks only; never called.
    // @ts-expect-error not a declared scope
    const badCreate = () => keys.create({ name: "x", scopes: ["users:read"] });
    // @ts-expect-error verify takes declared scopes, not wildcards
    const badVerify = () => keys.verify("x", { scopes: ["posts:*"] });
    const wildcard = () => keys.create({ name: "x", scopes: ["posts:*", "analytics:read"] });
    expect([badCreate, badVerify, wildcard].every((f) => typeof f === "function")).toBe(true);
    expect(Object.keys(keys.scopes)).toEqual(["posts:read", "posts:write", "analytics:read"]);
  });
});
