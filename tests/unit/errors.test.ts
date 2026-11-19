import { describe, expect, test } from "bun:test";
import { GroundworkError, isGroundworkError } from "../../src/internal/errors.ts";

describe("GroundworkError", () => {
  test("carries a code, a name and an optional cause", () => {
    const cause = new Error("connection refused");
    const error = new GroundworkError("invalid_config", "secret is missing", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GroundworkError");
    expect(error.code).toBe("invalid_config");
    expect(error.message).toBe("secret is missing");
    expect(error.cause).toBe(cause);
    expect(error.stack).toContain("GroundworkError");
  });
});

describe("isGroundworkError", () => {
  test("recognises groundwork errors", () => {
    expect(isGroundworkError(new GroundworkError("invalid_argument", "x"))).toBe(true);
  });

  test("recognises errors from a second copy of the package", () => {
    // A duplicate install has its own class, so instanceof fails; the shared brand still matches.
    class ForeignGroundworkError extends Error {
      readonly code = "invalid_config";
      constructor(message: string) {
        super(message);
        Object.defineProperty(this, Symbol.for("groundwork.error"), { value: true });
      }
    }
    const foreign = new ForeignGroundworkError("from another copy");
    expect(foreign instanceof GroundworkError).toBe(false);
    expect(isGroundworkError(foreign)).toBe(true);
  });

  test("rejects everything else", () => {
    for (const value of [
      new Error("x"),
      null,
      undefined,
      "GroundworkError",
      1,
      {},
      { code: "x" },
    ]) {
      expect(isGroundworkError(value)).toBe(false);
    }
  });
});
