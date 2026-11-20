import { describe, expect, test } from "bun:test";
import { createGroundwork } from "../../src/index.ts";
import { memoryStore } from "../../src/rate-limit/index.ts";
import { groundworkTables } from "../../src/schema/index.ts";
import { createTestClock } from "../../src/testing/index.ts";
import { TEST_SECRET } from "../support/rate-limit-conformance.ts";

const db = { execute: async () => [] };

describe("createGroundwork", () => {
  test("checks its options at startup", () => {
    expect(() => createGroundwork(undefined as never)).toThrow(/options object/);
    expect(() => createGroundwork({ db: {} as never, tables: {}, secret: TEST_SECRET })).toThrow(
      /db must be a Drizzle/,
    );
    expect(() => createGroundwork({ db, tables: undefined as never, secret: TEST_SECRET })).toThrow(
      /tables is required/,
    );
    // The secret is checked now, not on the first request.
    expect(() => createGroundwork({ db, tables: {}, secret: "short" })).toThrow(
      /at least 32 bytes/,
    );
  });

  test("a module whose table is missing throws when first used, not at startup", () => {
    const gw = createGroundwork({ db, tables: {}, secret: TEST_SECRET });
    expect(() => gw.rateLimit).toThrow(/needs the rateLimits table/);
  });

  test("accepts a whole schema module as tables", () => {
    const schemaModule = { ...groundworkTables({ schema: "ops" }), posts: {}, somethingElse: 42 };
    const gw = createGroundwork({ db, tables: schemaModule, secret: TEST_SECRET });
    expect(gw.rateLimit).toBe(gw.rateLimit);
  });

  test("uses the configured store and clock", async () => {
    const clock = createTestClock();
    const gw = createGroundwork({
      db,
      tables: {},
      secret: TEST_SECRET,
      clock,
      rateLimit: { store: memoryStore({ clock }) },
    });
    const rule = gw.rateLimit.rule({ name: "r", limit: 1, window: "1m" });
    expect((await rule.check("x")).allowed).toBe(true);
    expect((await rule.check("x")).allowed).toBe(false);
    clock.advance("1m");
    expect((await rule.check("x")).allowed).toBe(true);
  });
});

describe("a secret function", () => {
  test("is called on first use, once, not at startup", async () => {
    let calls = 0;
    const gw = createGroundwork({
      db,
      tables: {},
      secret: () => {
        calls++;
        return TEST_SECRET;
      },
      rateLimit: { store: memoryStore() },
    });
    const rule = gw.rateLimit.rule({ name: "r", limit: 5, window: "1m" });
    expect(calls).toBe(0);
    await rule.check("x");
    await rule.check("x");
    expect(calls).toBe(1);
  });

  test("that returns a short secret fails on first use", async () => {
    const gw = createGroundwork({
      db,
      tables: {},
      secret: () => "short",
      rateLimit: { store: memoryStore() },
    });
    const rule = gw.rateLimit.rule({ name: "r", limit: 5, window: "1m" });
    await expect(rule.check("x")).rejects.toThrow(/at least 32 bytes/);
  });
});
