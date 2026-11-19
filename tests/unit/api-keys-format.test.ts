import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import {
  checksumOf,
  crc32,
  generateKey,
  hashKey,
  parseKey,
  redactKeys,
  validateNamespace,
} from "../../src/api-keys/format.ts";
import {
  extractKey,
  normalizeOrigin,
  validateIps,
  validateOrigins,
} from "../../src/api-keys/policy.ts";
import { failureHeaders, failureResponse, STATUS } from "../../src/api-keys/responses.ts";
import { createScopeRules, type GrantedScope } from "../../src/api-keys/scopes.ts";
import { deriveSubkey } from "../../src/internal/crypto.ts";
import { TEST_SECRET } from "../support/rate-limit-conformance.ts";

describe("key format", () => {
  test("generated keys look like vnt_<12 hex>_<43 base64url><6 base62>", () => {
    const { key, body, prefix } = generateKey("vnt", true);
    expect(key).toMatch(/^vnt_[0-9a-f]{12}_[A-Za-z0-9_-]{43}[0-9A-Za-z]{6}$/);
    expect(body).toBe(key.slice(0, -6));
    expect(key.slice(4, 16)).toBe(prefix);
    expect(parseKey(key, "vnt")).toEqual({ body, prefix });
    expect(generateKey("vnt", false).key).toMatch(/^vnt_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  });

  test("keys are unique", () => {
    const keys = new Set(Array.from({ length: 2_000 }, () => generateKey("vnt", true).key));
    expect(keys.size).toBe(2_000);
  });

  test("our CRC32 matches zlib's", () => {
    for (let i = 0; i < 200; i++) {
      const text = randomBytes(1 + (i % 64)).toString("base64url");
      expect(crc32(text)).toBe(zlib.crc32(text));
    }
    expect(crc32("")).toBe(0);
    expect(checksumOf("vnt_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      checksumOf("vnt_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    );
  });

  test("every single-character typo is caught by the checksum, without a database lookup", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    for (let round = 0; round < 5; round++) {
      const { key } = generateKey("vnt", true);
      for (let i = 0; i < key.length; i++) {
        for (const replacement of alphabet) {
          if (replacement === key[i]) continue;
          const typo = key.slice(0, i) + replacement + key.slice(i + 1);
          expect(parseKey(typo, "vnt")).toBeNull();
        }
      }
    }
  });

  test("keys without a checksum (such as vante.app's) still parse", () => {
    const legacy = `vnt_${"a".repeat(12)}_${"b".repeat(43)}`;
    expect(parseKey(legacy, "vnt")).toEqual({ body: legacy, prefix: "a".repeat(12) });
  });

  test.each([
    ["empty", ""],
    ["another namespace", `abc_${"a".repeat(12)}_${"b".repeat(43)}`],
    ["upper-case hex", `vnt_${"A".repeat(12)}_${"b".repeat(43)}`],
    ["a short prefix", `vnt_${"a".repeat(11)}_${"b".repeat(44)}`],
    ["a missing separator", `vnt_${"a".repeat(12)}-${"b".repeat(43)}`],
    ["a short secret", `vnt_${"a".repeat(12)}_${"b".repeat(42)}`],
    ["a bad character", `vnt_${"a".repeat(12)}_${"b".repeat(42)}!`],
    ["a wrong checksum", `vnt_${"a".repeat(12)}_${"b".repeat(43)}000000`],
    ["trailing junk", `vnt_${"a".repeat(12)}_${"b".repeat(43)}x`],
    ["a huge string", `vnt_${"a".repeat(100_000)}`],
  ])("rejects %s", (_, raw) => {
    expect(parseKey(raw, "vnt")).toBeNull();
  });

  test("the stored hash and the checksum never change (they are part of the storage format)", () => {
    // If this fails, every existing API key would stop verifying.
    const body = `vnt_${"a".repeat(12)}_${"b".repeat(43)}`;
    expect(hashKey(deriveSubkey(TEST_SECRET, "api-keys"), body)).toBe(
      "22142cd4aebb0fa50c22019d17f46c95ce145365c21164526416131c6a12b9a9",
    );
    expect(checksumOf(body)).toBe("3zB4cD");
    expect(parseKey(`${body}3zB4cD`, "vnt")).toEqual({ body, prefix: "a".repeat(12) });
  });

  test("redactKeys hides keys in logs and URLs, keeping the prefix", () => {
    const { key, prefix } = generateKey("vnt", true);
    expect(redactKeys(`GET /hook?token=${key} 200`, "vnt")).toBe(
      `GET /hook?token=vnt_${prefix}_[redacted] 200`,
    );
    expect(redactKeys("nothing here", "vnt")).toBe("nothing here");
  });

  test("namespaces are short, lower-case and start with a letter", () => {
    expect(validateNamespace("vnt")).toBe("vnt");
    for (const bad of ["", "v", "VNT", "1vn", "v_n", "a".repeat(17), 5]) {
      expect(() => validateNamespace(bad)).toThrow(/Invalid API key namespace/);
    }
  });
});

describe("scopes", () => {
  const rules = createScopeRules({
    "posts:read": "Read posts",
    "posts:write": "Write posts",
    "analytics:read": "Read analytics",
    admin: "Everything",
  });

  test("grants declared scopes and resource wildcards only", () => {
    expect(rules.grantable(["posts:read", "posts:*", "posts:read"], "scopes")).toEqual([
      "posts:read",
      "posts:*",
    ]);
    expect(() => rules.grantable(["posts:delete"], "scopes")).toThrow(
      /Unknown scope "posts:delete"/,
    );
    expect(() => rules.grantable(["users:*"], "scopes")).toThrow(/Unknown scope "users:\*"/);
    expect(() => rules.grantable(["*"], "scopes")).toThrow(/Unknown scope/);
    expect(() => rules.grantable("posts:read", "scopes")).toThrow(/must be an array/);
  });

  test("a requirement is met exactly or by its resource's wildcard", () => {
    expect(rules.missing(["posts:read"], ["posts:read"])).toEqual([]);
    expect(rules.missing(["posts:*"], ["posts:read", "posts:write"])).toEqual([]);
    expect(rules.missing(["posts:read"], ["posts:read", "posts:write"])).toEqual(["posts:write"]);
    expect(rules.missing(["posts:*"], ["analytics:read"])).toEqual(["analytics:read"]);
    expect(rules.missing(["admin"], ["admin"])).toEqual([]);
    expect(rules.missing([], [])).toEqual([]);
  });

  test("rejects bad declarations", () => {
    expect(() => createScopeRules(["posts:read"])).toThrow(/must be an object/);
    expect(() => createScopeRules({ "posts:*": "x" })).toThrow(/Invalid scope "posts:\*"/);
    expect(() => createScopeRules({ "posts read": "x" })).toThrow(/Invalid scope/);
    expect(() => createScopeRules({ "posts:read": 1 })).toThrow(/description/);
  });

  test("wildcards are typed from the declared scopes", () => {
    type Scope = "posts:read" | "posts:write" | "admin";
    const ok: GrantedScope<Scope>[] = ["posts:read", "posts:*", "admin"];
    // @ts-expect-error no such resource
    const bad: GrantedScope<Scope>[] = ["users:*"];
    expect([ok, bad]).toHaveLength(2);
  });
});

describe("request policy", () => {
  test.each([
    ["https://app.example.com", "https://app.example.com"],
    ["https://APP.Example.com/", "https://app.example.com"],
    ["https://app.example.com:443", "https://app.example.com"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
  ])("normalises the origin %p", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  test.each([
    ["null"],
    ["app.example.com"],
    ["ftp://x.com"],
    ["https://x.com/path"],
    ["https://x.com?q=1"],
    ["https://u:p@x.com"],
    [""],
  ])("refuses the origin %p", (input) => {
    expect(normalizeOrigin(input)).toBeNull();
  });

  test("validates allowlists, deduplicated and canonical", () => {
    expect(validateOrigins(["https://A.com", "https://a.com:443"], "allowedOrigins")).toEqual([
      "https://a.com",
    ]);
    expect(() => validateOrigins(["a.com"], "allowedOrigins")).toThrow(/Invalid origin "a.com"/);
    expect(
      validateIps(["203.0.113.0/24", "2001:DB8::/32", "203.0.113.0/24"], "allowedIps"),
    ).toEqual(["203.0.113.0/24", "2001:db8::/32"]);
    expect(() => validateIps(["10.0.0.1/8"], "allowedIps")).toThrow(/did you mean 10.0.0.0\/8/);
  });

  test("finds the key in Authorization: Bearer, else X-API-Key", () => {
    expect(extractKey(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
    expect(extractKey(new Headers({ authorization: "bearer   abc  " }))).toBe("abc");
    expect(extractKey(new Headers({ "x-api-key": " abc " }))).toBe("abc");
    expect(
      extractKey(new Headers({ authorization: "Basic dXNlcjpwYXNz", "x-api-key": "fallback" })),
    ).toBe("fallback");
    expect(extractKey(new Headers({ authorization: "Basic dXNlcjpwYXNz" }))).toBeNull();
    expect(extractKey(new Headers({ authorization: "Bearer a b" }))).toBeNull();
    expect(
      extractKey(new Request("https://x.test", { headers: { authorization: "Bearer k" } })),
    ).toBe("k");
    expect(extractKey(" raw ")).toBe("raw");
    expect(extractKey("")).toBeNull();
    expect(extractKey(null)).toBeNull();
    expect(extractKey(new Headers())).toBeNull();
  });
});

describe("failure responses", () => {
  test("401s challenge for a bearer token, 403 for a scope says which", async () => {
    expect(failureHeaders("missing", [], {})["WWW-Authenticate"]).toBe("Bearer");
    expect(failureHeaders("revoked", [], {})["WWW-Authenticate"]).toBe(
      'Bearer error="invalid_token"',
    );
    expect(
      failureHeaders("forbidden_scope", ["posts:write", "posts:read"], {})["WWW-Authenticate"],
    ).toBe('Bearer error="insufficient_scope", scope="posts:write posts:read"');
    expect(failureHeaders("ip_denied", [], {})["WWW-Authenticate"]).toBeUndefined();
    expect(failureHeaders("rate_limited", [], { "Retry-After": "5" })).toEqual({
      "Cache-Control": "no-store",
      "Retry-After": "5",
    });

    const response = failureResponse("forbidden_scope", { "Cache-Control": "no-store" }, [
      "posts:write",
    ]);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden_scope",
        message: "This API key does not have the scopes this request needs.",
        missingScopes: ["posts:write"],
      },
    });
  });

  test("every reason has a status", () => {
    expect(STATUS).toEqual({
      missing: 401,
      malformed: 401,
      invalid: 401,
      revoked: 401,
      expired: 401,
      suspended: 403,
      forbidden_scope: 403,
      ip_denied: 403,
      origin_denied: 403,
      rate_limited: 429,
      quota_exceeded: 429,
    });
  });
});
