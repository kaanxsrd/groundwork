import { describe, expect, test } from "bun:test";
import { createRedactor, DEFAULT_REDACT, REDACTED, toJsonObject } from "../../src/audit/json.ts";
import { isGroundworkError } from "../../src/internal/errors.ts";

const defaults = createRedactor(DEFAULT_REDACT);
const json = (value: unknown, redact = defaults) => toJsonObject(value, redact, "changes");

describe("redaction", () => {
  test("replaces matching keys at any depth, in objects and in arrays", () => {
    const input = {
      name: "Ada",
      password: "hunter2",
      profile: {
        settings: { apiKey: "sk_live_1", theme: "dark" },
        sessions: [{ id: 1, sessionToken: "abc" }, { id: 2 }],
      },
      changes: { password: ["old", "new"] },
    };
    expect(json(input)).toEqual({
      name: "Ada",
      password: REDACTED,
      profile: {
        settings: { apiKey: REDACTED, theme: "dark" },
        sessions: [{ id: 1, sessionToken: REDACTED }, { id: 2 }],
      },
      changes: { password: REDACTED },
    });
    expect(JSON.stringify(json(input))).not.toMatch(/hunter2|sk_live_1|abc|"old"|"new"/);
  });

  test("matches keys that contain a rule, ignoring case, _ and -", () => {
    const keys = [
      "accessToken",
      "refresh_token",
      "X-Api-Key",
      "PASSWORD_HASH",
      "clientSecret",
      "Set-Cookie",
      "authorization",
    ];
    const redacted = json(Object.fromEntries(keys.map((key) => [key, "x"])));
    expect(Object.values(redacted ?? {})).toEqual(keys.map(() => REDACTED));
  });

  test("leaves other keys alone", () => {
    expect(json({ email: "a@b.c", title: "t", passage: "p" })).toEqual({
      email: "a@b.c",
      title: "t",
      passage: "p",
    });
  });

  test("custom words and RegExps add to the defaults, or replace them", () => {
    const custom = createRedactor([...DEFAULT_REDACT, "iban", /^ssn$/i]);
    expect(
      json({ iban: "DK50", bankIban: "DK51", SSN: "1", ssnLast4: "2", token: "t" }, custom),
    ).toEqual({
      iban: REDACTED,
      bankIban: REDACTED,
      SSN: REDACTED,
      ssnLast4: "2",
      token: REDACTED,
    });
    const only = createRedactor(["iban"]);
    expect(json({ iban: "x", token: "kept" }, only)).toEqual({ iban: REDACTED, token: "kept" });
  });

  test("a global RegExp gives the same answer every time", () => {
    const redact = createRedactor([/pin/g]);
    expect([redact("pin"), redact("pin"), redact("pin")]).toEqual([true, true, true]);
  });

  test("rejects empty or non-string rules", () => {
    for (const rule of ["", "--", 42, null]) {
      let caught: unknown;
      try {
        createRedactor([rule as string]);
      } catch (error) {
        caught = error;
      }
      expect(isGroundworkError(caught) && caught.code).toBe("invalid_config");
    }
  });

  test("never modifies the input", () => {
    const input = Object.freeze({ password: "x", nested: Object.freeze({ token: "y" }) });
    expect(json(input)).toEqual({ password: REDACTED, nested: { token: REDACTED } });
    expect(input.password).toBe("x");
  });
});

describe("JSON normalisation", () => {
  test("turns non-JSON values into JSON", () => {
    expect(
      json({
        at: new Date("2026-01-01T00:00:00Z"),
        bad: new Date(Number.NaN),
        big: 12345678901234567890n,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        skip: undefined,
        fn: () => 1,
        list: [undefined, () => 1, 1],
        set: new Set(["a"]),
        map: new Map<unknown, unknown>([
          [1, "one"],
          ["password", "x"],
        ]),
        buffer: Buffer.from("hi"),
      }),
    ).toEqual({
      at: "2026-01-01T00:00:00.000Z",
      bad: null,
      big: "12345678901234567890",
      nan: null,
      inf: null,
      list: [null, null, 1],
      set: ["a"],
      map: { "1": "one", password: REDACTED },
      buffer: { type: "Buffer", data: [104, 105] },
    });
  });

  test("cuts cycles but keeps values referenced twice", () => {
    const shared = { x: 1 };
    const cyclic: Record<string, unknown> = { shared, again: shared };
    cyclic.self = cyclic;
    expect(json(cyclic)).toEqual({ shared: { x: 1 }, again: { x: 1 }, self: "[circular]" });
  });

  test("truncates absurdly deep values", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i++) deep = { deep };
    expect(JSON.stringify(json(deep))).toContain("[truncated]");
  });

  test("only accepts objects at the top", () => {
    expect(json(null)).toBeNull();
    expect(json(undefined)).toBeNull();
    for (const value of ["text", 1, [1], new Date()]) {
      expect(() => json(value)).toThrow(/changes must be a plain object/);
    }
  });
});
