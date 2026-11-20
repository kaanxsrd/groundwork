import { describe, expect, test } from "bun:test";
import type { SQLWrapper } from "drizzle-orm";
import { decodeResponse, encodeResponse, isStoredResponse } from "../../src/idempotency/http.ts";
import {
  createIdempotency,
  type Jsonify,
  parseIdempotencyKey,
  REPLAYED_HEADER,
} from "../../src/idempotency/index.ts";
import { createKeyHasher } from "../../src/idempotency/keys.ts";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";
import { groundworkTables } from "../../src/schema/index.ts";

const SECRET = "conformance-test-secret-0123456789abcdef";
const { idempotencyKeys: table, rateLimits } = groundworkTables();
const quiet = { warn: () => {}, error: () => {} };

function recordingDb() {
  const calls: SQLWrapper[] = [];
  const execute = async (query: SQLWrapper) => {
    calls.push(query);
    return [];
  };
  return { calls, db: { execute } };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isGroundworkError(error) ? error.code : `not a GroundworkError: ${String(error)}`;
  }
  return undefined;
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (error) {
    return isGroundworkError(error) ? error.code : `not a GroundworkError: ${String(error)}`;
  }
  return undefined;
}

describe("parseIdempotencyKey", () => {
  test("accepts a bare key, as Stripe's and VaultDrop's clients send it", () => {
    expect(parseIdempotencyKey("8e03978e-40d5-43e8-bc93-6894a57f9324")).toBe(
      "8e03978e-40d5-43e8-bc93-6894a57f9324",
    );
    expect(parseIdempotencyKey("  deploy-2026-10-28-001 ")).toBe("deploy-2026-10-28-001");
    expect(parseIdempotencyKey("a+b/c=d_e.f:g~h")).toBe("a+b/c=d_e.f:g~h");
  });

  test("accepts a Structured Field string, as the draft specifies", () => {
    expect(parseIdempotencyKey('"8e03978e-40d5-43e8-bc93-6894a57f9324"')).toBe(
      "8e03978e-40d5-43e8-bc93-6894a57f9324",
    );
    expect(parseIdempotencyKey('"abc\\"defgh"')).toBe('abc"defgh');
    expect(parseIdempotencyKey('"abc\\\\defgh"')).toBe("abc\\defgh");
  });

  test.each([
    ["", "empty"],
    ["short", "shorter than 8"],
    ["x".repeat(256), "longer than 255"],
    ["has space inside", "a space"],
    ["tab\there12", "a control character"],
    ["ключ-ключ-ключ", "non-ASCII"],
    ['"unterminated', "an unterminated string"],
    ['"abcdefgh";a=1', "parameters"],
    ['"abcdefgh" trailing', "text after the string"],
    ['"bad\\escape1"', 'an escape other than \\" and \\\\'],
    ['"short"', "a quoted key shorter than 8"],
    ['"with space"', "a quoted key with a space"],
  ])("rejects %p (%s)", (value) => {
    expect(parseIdempotencyKey(value)).toBeNull();
  });
});

describe("stored responses", () => {
  test("keep status, statusText and headers, but never cookies or per-request headers", () => {
    const response = new Response("{}", {
      status: 201,
      statusText: "Created",
      headers: {
        "Content-Type": "application/json",
        Location: "/orders/1",
        "X-Request-Id": "abc",
        "Set-Cookie": "session=secret",
        RateLimit: '"api";r=9;t=60',
        "RateLimit-Policy": '"api";q=10;w=60',
        "Retry-After": "5",
        Date: "Thu, 19 Nov 2026 10:00:00 GMT",
        [REPLAYED_HEADER]: "true",
      },
    });
    const stored = encodeResponse(response, new TextEncoder().encode("{}"));
    expect(stored.status).toBe(201);
    expect(stored.statusText).toBe("Created");
    expect(Object.fromEntries(stored.headers)).toEqual({
      "content-type": "application/json",
      location: "/orders/1",
      "x-request-id": "abc",
    });
    expect(JSON.stringify(stored)).not.toContain("secret");
  });

  test("store UTF-8 bodies as text and anything else as base64", () => {
    const text = encodeResponse(new Response(null), new TextEncoder().encode("héllo \u0000 wörld"));
    expect(text).toMatchObject({ body: "héllo \u0000 wörld", encoding: "utf8" });
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const encoded = encodeResponse(new Response(null), binary);
    expect(encoded).toMatchObject({ body: "//4AgA==", encoding: "base64" });
    // JSON text keeps NUL characters (jsonb would reject them), so the round trip is exact.
    expect(JSON.parse(JSON.stringify(text))).toEqual(text);
  });

  test("rebuild the same response, marked as replayed", async () => {
    const original = new Response(new Uint8Array([1, 2, 3, 255]), {
      status: 202,
      headers: { "Content-Type": "application/octet-stream", Vary: "Accept" },
    });
    const stored = encodeResponse(original, new Uint8Array([1, 2, 3, 255]));
    const replay = decodeResponse(JSON.parse(JSON.stringify(stored)));
    expect(replay.status).toBe(202);
    expect(replay.headers.get("content-type")).toBe("application/octet-stream");
    expect(replay.headers.get("vary")).toBe("Accept");
    expect(replay.headers.get(REPLAYED_HEADER)).toBe("true");
    expect([...new Uint8Array(await replay.arrayBuffer())]).toEqual([1, 2, 3, 255]);
  });

  test("rebuild null-body statuses without a body", () => {
    for (const status of [204, 205, 304]) {
      const replay = decodeResponse({ status, headers: [], body: "", encoding: "utf8" });
      expect([replay.status, replay.body]).toEqual([status, null]);
    }
  });

  test("are recognised only in the stored shape", () => {
    expect(isStoredResponse({ status: 200, headers: [], body: "", encoding: "utf8" })).toBe(true);
    expect(isStoredResponse({ value: 1 })).toBe(false);
    expect(isStoredResponse({ status: 200, headers: [], body: "", encoding: "hex" })).toBe(false);
    expect(isStoredResponse(null)).toBe(false);
  });
});

describe("key hashing", () => {
  const hasher = createKeyHasher(deriveSubkey(SECRET, "idempotency"));

  test("never changes (it is part of the storage format)", () => {
    expect(hasher.storageKey("http", "apikey:42", "order-2026-11-19-0001")).toBe(
      "WYCqJ8Krg-_rH1zTNnQdjpYbPIyw6wisVoTXgCV3LEc",
    );
    expect(hasher.storageKey("run", "apikey:42", "order-2026-11-19-0001")).toBe(
      "tDtwt6WD5B4eI3rztgvzCN7_0d6ZrfHcqR_6kUWINUE",
    );
    expect(
      hasher.fingerprint([
        "request",
        "POST",
        "/v1/orders",
        new TextEncoder().encode('{"sku":"A1"}'),
      ]),
    ).toBe("sPRTSTxdf3ybN31YwOd9QVwvsF_YEq6yBsps2XcvHAQ");
  });

  test("keeps scopes, kinds and parts apart", () => {
    const keys = new Set([
      hasher.storageKey("http", "a", "bc-key-1"),
      hasher.storageKey("http", "ab", "c-key-1"),
      hasher.storageKey("run", "a", "bc-key-1"),
      hasher.storageKey("http", "b", "bc-key-1"),
    ]);
    expect(keys.size).toBe(4);
    expect(hasher.fingerprint(["custom", "x"])).not.toBe(hasher.fingerprint(["none"]));
  });

  test("hashes bytes and the same text alike", () => {
    expect(hasher.fingerprint(["custom", new TextEncoder().encode("héllo")])).toBe(
      hasher.fingerprint(["custom", "héllo"]),
    );
  });

  test("uses a key derived from the secret, so another secret gives other hashes", () => {
    const other = createKeyHasher(deriveSubkey(`${SECRET}-other`, "idempotency"));
    expect(other.storageKey("http", "s", "k")).not.toBe(hasher.storageKey("http", "s", "k"));
  });
});

describe("createIdempotency", () => {
  test("checks its options at startup", () => {
    const { db } = recordingDb();
    expect(codeOf(() => createIdempotency(undefined as never))).toBe("invalid_config");
    expect(codeOf(() => createIdempotency({ db: {} as never, table, secret: SECRET }))).toBe(
      "invalid_config",
    );
    expect(
      codeOf(() => createIdempotency({ db, table: rateLimits as never, secret: SECRET })),
    ).toBe("invalid_config");
    expect(codeOf(() => createIdempotency({ db, table, secret: "too short" }))).toBe(
      "invalid_config",
    );
    expect(codeOf(() => createIdempotency({ db, table, secret: SECRET, ttl: "0.5s" }))).toBe(
      "invalid_argument",
    );
    expect(
      codeOf(() => createIdempotency({ db, table, secret: SECRET, lease: "10" as never })),
    ).toBe("invalid_argument");
  });

  test("rejects bad arguments before touching the database", async () => {
    const { db, calls } = recordingDb();
    const idempotency = createIdempotency({ db, table, secret: SECRET, logger: quiet });
    const request = () =>
      new Request("https://example.test/orders", {
        method: "POST",
        headers: { "Idempotency-Key": "order-key-0001" },
        body: "{}",
      });
    const ok = () => new Response("ok");
    expect(await asyncCodeOf(() => idempotency.handle(request(), {} as never, ok))).toBe(
      "invalid_argument",
    );
    expect(await asyncCodeOf(() => idempotency.handle(request(), { scope: "" }, ok))).toBe(
      "invalid_argument",
    );
    expect(
      await asyncCodeOf(() => idempotency.handle(request(), { scope: "s".repeat(256) }, ok)),
    ).toBe("invalid_argument");
    expect(
      await asyncCodeOf(() =>
        idempotency.handle(request(), { scope: "s", ttl: "forever" as never }, ok),
      ),
    ).toBe("invalid_argument");
    expect(
      await asyncCodeOf(() =>
        idempotency.handle(request(), { scope: "s", fingerprint: 5 as never }, ok),
      ),
    ).toBe("invalid_argument");
    expect(await asyncCodeOf(() => idempotency.run({ scope: "s", key: "" }, () => 1))).toBe(
      "invalid_argument",
    );
    expect(
      await asyncCodeOf(() => idempotency.run({ scope: "s", key: "k".repeat(256) }, () => 1)),
    ).toBe("invalid_argument");
    expect(await asyncCodeOf(() => idempotency.run({ scope: "s", key: "k" }, 5 as never))).toBe(
      "invalid_argument",
    );
    const used = request();
    await used.text();
    expect(await asyncCodeOf(() => idempotency.handle(used, { scope: "s" }, ok))).toBe(
      "invalid_argument",
    );
    expect(calls).toHaveLength(0);
  });

  test("answers missing and malformed keys without touching the database", async () => {
    const { db, calls } = recordingDb();
    const idempotency = createIdempotency({ db, table, secret: SECRET, logger: quiet });
    let runs = 0;
    const handler = () => {
      runs++;
      return new Response("ran");
    };
    const plain = new Request("https://example.test/orders", { method: "POST", body: "{}" });
    expect(await (await idempotency.handle(plain, { scope: "s" }, handler)).text()).toBe("ran");

    const required = await idempotency.handle(
      new Request("https://example.test/orders", { method: "POST", body: "{}" }),
      { scope: "s", required: true },
      handler,
    );
    expect(required.status).toBe(400);
    expect(await required.json()).toEqual({
      error: {
        code: "idempotency_key_missing",
        message: "This request needs an Idempotency-Key header.",
      },
    });

    const malformed = await idempotency.handle(
      new Request("https://example.test/orders", {
        method: "POST",
        headers: { "Idempotency-Key": "short" },
        body: "{}",
      }),
      { scope: "s" },
      handler,
    );
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency_key_invalid",
    );
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    expect([runs, calls.length]).toEqual([1, 0]);
  });
});

describe("Jsonify", () => {
  test("describes what a value becomes after a trip through JSON", () => {
    type Input = {
      id: string;
      at: Date;
      count: number;
      maybe?: string | undefined;
      nested: { flag: boolean; when: Date[] };
      list: (string | undefined)[];
      fn: () => void;
      nothing: undefined;
    };
    type Expected = {
      id: string;
      at: string;
      count: number;
      maybe?: string;
      nested: { flag: boolean; when: string[] };
      list: (string | null)[];
    };
    const value: Jsonify<Input> = {
      id: "a",
      at: "2026-11-19T00:00:00.000Z",
      count: 1,
      nested: { flag: true, when: [] },
      list: ["x", null],
    };
    const back: Expected = value;
    // @ts-expect-error a Date is a string after JSON
    const bad: Jsonify<{ at: Date }> = { at: new Date() };
    const unknownStaysUnknown: Jsonify<unknown> = { anything: true };
    const interfaceWorks: Jsonify<Iface> = { name: "x" };
    expect([back, bad, unknownStaysUnknown, interfaceWorks]).toHaveLength(4);
  });
});

interface Iface {
  name: string;
}
