import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  deriveSubkey,
  deriveSubkeys,
  hmacSha256,
  hmacSha256Parts,
  KEY_PURPOSES,
  MIN_SECRET_BYTES,
  randomBase64Url,
  randomHex,
  timingSafeEqual,
} from "../../src/internal/crypto.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";

const SECRET = "groundwork-test-secret-0123456789abcdef";

/** RFC 5869 written out with plain HMAC, independent of node:crypto's hkdf. */
function referenceHkdf(ikm: Buffer, salt: string, info: string, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    previous = createHmac("sha256", prk)
      .update(Buffer.concat([previous, Buffer.from(info), Buffer.from([i])]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

describe("deriveSubkey", () => {
  test("is HKDF-SHA256 with the documented salt and info", () => {
    for (const purpose of KEY_PURPOSES) {
      const expected = referenceHkdf(
        Buffer.from(SECRET),
        "groundwork/v1",
        `groundwork/v1/${purpose}`,
        32,
      );
      expect(deriveSubkey(SECRET, purpose).equals(expected)).toBe(true);
    }
  });

  test("never changes (it is part of the storage format)", () => {
    // If this fails, every stored API key hash and rate-limit key would stop matching.
    expect(deriveSubkey(SECRET, "rate-limit").toString("hex")).toBe(
      "1e4317f5d190e98831783b8bcd0c6fa469c6c2a71f0d9806234022279d9775f2",
    );
    expect(deriveSubkey(SECRET, "api-keys").toString("hex")).toBe(
      "3f9ca0c44a15e23f7e10c4c775959e14ff79d3b6c9e020095d9cdcda578eb7cb",
    );
    expect(deriveSubkey(SECRET, "idempotency").toString("hex")).toBe(
      "6de648205097ef075acea06627c5f4b51f231240f5cf621a13e12e172ca46200",
    );
  });

  test("gives every purpose a different 32-byte key", () => {
    const keys = KEY_PURPOSES.map((purpose) => deriveSubkey(SECRET, purpose).toString("hex"));
    expect(new Set(keys).size).toBe(KEY_PURPOSES.length);
    for (const key of keys) expect(key).toHaveLength(64);
  });

  test("treats a string secret as its UTF-8 bytes", () => {
    expect(deriveSubkey(Buffer.from(SECRET), "api-keys")).toEqual(deriveSubkey(SECRET, "api-keys"));
    expect(deriveSubkey(new Uint8Array(Buffer.from(SECRET)), "api-keys")).toEqual(
      deriveSubkey(SECRET, "api-keys"),
    );
  });

  test("depends on every byte of the secret", () => {
    const other = `${SECRET.slice(0, -1)}e`;
    expect(deriveSubkey(other, "api-keys")).not.toEqual(deriveSubkey(SECRET, "api-keys"));
  });

  test("rejects a short secret without echoing it", () => {
    const short = "x".repeat(MIN_SECRET_BYTES - 1);
    let caught: unknown;
    try {
      deriveSubkey(short, "api-keys");
    } catch (error) {
      caught = error;
    }
    expect(isGroundworkError(caught)).toBe(true);
    if (!isGroundworkError(caught)) return;
    expect(caught.code).toBe("invalid_config");
    expect(caught.message).not.toContain(short);
    expect(caught.message).toContain("openssl rand -base64 32");
  });

  test("counts bytes, not characters", () => {
    // 11 three-byte characters = 33 bytes, enough even though it is only 11 characters long.
    expect(() => deriveSubkey("€".repeat(11), "api-keys")).not.toThrow();
    expect(() => deriveSubkey("€".repeat(10), "api-keys")).toThrow();
  });

  test("rejects a secret that is not a string or bytes", () => {
    expect(() => deriveSubkey(42 as unknown as string, "api-keys")).toThrow(
      /string or a Uint8Array/,
    );
    expect(() => deriveSubkey(undefined as unknown as string, "api-keys")).toThrow();
  });
});

describe("deriveSubkeys", () => {
  test("matches deriveSubkey for every purpose and is frozen", () => {
    const keys = deriveSubkeys(SECRET);
    for (const purpose of KEY_PURPOSES) {
      expect(keys[purpose]).toEqual(deriveSubkey(SECRET, purpose));
    }
    expect(Object.isFrozen(keys)).toBe(true);
  });

  test("validates the secret too", () => {
    expect(() => deriveSubkeys("too short")).toThrow(/at least 32 bytes/);
  });
});

describe("hmacSha256", () => {
  test("is plain HMAC-SHA256", () => {
    const key = deriveSubkey(SECRET, "api-keys");
    expect(hmacSha256(key, "message")).toEqual(
      createHmac("sha256", key).update("message").digest(),
    );
  });
});

describe("hmacSha256Parts", () => {
  const key = deriveSubkey(SECRET, "rate-limit");

  test("never confuses where one part ends and the next begins", () => {
    const ab_c = hmacSha256Parts(key, ["ab", "c"]);
    const a_bc = hmacSha256Parts(key, ["a", "bc"]);
    const abc = hmacSha256Parts(key, ["abc"]);
    expect(ab_c).not.toEqual(a_bc);
    expect(ab_c).not.toEqual(abc);
    expect(hmacSha256Parts(key, ["", "x"])).not.toEqual(hmacSha256Parts(key, ["x", ""]));
    expect(hmacSha256Parts(key, [])).not.toEqual(hmacSha256Parts(key, [""]));
  });

  test("prefixes each part with its UTF-8 byte length", () => {
    const manual = createHmac("sha256", key)
      .update(Buffer.from([0, 0, 0, 3]))
      .update("€")
      .update(Buffer.from([0, 0, 0, 1]))
      .update("a")
      .digest();
    expect(hmacSha256Parts(key, ["€", "a"])).toEqual(manual);
  });

  test("hashes byte parts exactly like the same text", () => {
    const bytes = new TextEncoder().encode("€a");
    expect(hmacSha256Parts(key, [bytes, "x"])).toEqual(hmacSha256Parts(key, ["€a", "x"]));
    expect(hmacSha256Parts(key, [new Uint8Array([0xff])])).not.toEqual(hmacSha256Parts(key, ["�"]));
  });

  test("never changes (it is part of the storage format)", () => {
    expect(hmacSha256Parts(key, ["login:ip", "203.0.113.7"]).toString("base64url")).toBe(
      "6Zimm64yD_Pf1iwao_wIzT0GHrsE49hevETokNcDSRw",
    );
  });
});

describe("timingSafeEqual", () => {
  test("compares strings and bytes", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual(Buffer.from("abc"), "abc")).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });

  test("compares UTF-8 bytes, not UTF-16 code units", () => {
    expect(timingSafeEqual("é", "é")).toBe(true);
    // "é" precomposed vs "e" + combining accent: same look, different bytes.
    expect(timingSafeEqual("é", "é")).toBe(false);
  });
});

describe("random helpers", () => {
  test("randomHex returns 2 hex characters per byte", () => {
    const value = randomHex(6);
    expect(value).toMatch(/^[0-9a-f]{12}$/);
    expect(randomHex(6)).not.toBe(value);
  });

  test("randomBase64Url returns unpadded base64url", () => {
    const value = randomBase64Url(32);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const many = new Set(Array.from({ length: 1000 }, () => randomBase64Url(16)));
    expect(many.size).toBe(1000);
  });
});
