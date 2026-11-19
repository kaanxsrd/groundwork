import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  consoleLogger,
  createOnceLogger,
  type LogContext,
  type Logger,
} from "../../src/internal/logger.ts";

function recordingLogger(): Logger & { lines: [string, string, LogContext | undefined][] } {
  const lines: [string, string, LogContext | undefined][] = [];
  return {
    lines,
    info: (message, context) => lines.push(["info", message, context]),
    warn: (message, context) => lines.push(["warn", message, context]),
    error: (message, context) => lines.push(["error", message, context]),
  };
}

describe("createOnceLogger", () => {
  test("logs each key once", () => {
    const logger = recordingLogger();
    const once = createOnceLogger(logger);
    expect(once.once("warn", "fallback", "using memory", { rule: "login" })).toBe(true);
    expect(once.once("warn", "fallback", "using memory", { rule: "login" })).toBe(false);
    expect(once.once("error", "other", "boom")).toBe(true);
    expect(logger.lines).toEqual([
      ["warn", "using memory", { rule: "login" }],
      ["error", "boom", undefined],
    ]);
  });

  test("logs a key again after reset", () => {
    const logger = recordingLogger();
    const once = createOnceLogger(logger);
    once.once("warn", "a", "first");
    once.once("warn", "b", "first");
    once.reset("a");
    expect(once.once("warn", "a", "second")).toBe(true);
    expect(once.once("warn", "b", "second")).toBe(false);
    once.reset();
    expect(once.once("warn", "b", "third")).toBe(true);
    expect(logger.lines.map(([, message]) => message)).toEqual([
      "first",
      "first",
      "second",
      "third",
    ]);
  });

  test("keeps no state between wrappers", () => {
    const logger = recordingLogger();
    createOnceLogger(logger).once("warn", "k", "one");
    createOnceLogger(logger).once("warn", "k", "two");
    expect(logger.lines).toHaveLength(2);
  });

  test("skips levels the logger does not implement", () => {
    const once = createOnceLogger({ warn: () => {}, error: () => {} });
    expect(() => once.once("debug", "k", "dropped")).not.toThrow();
  });
});

describe("consoleLogger", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("prefixes warnings and errors", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    spies.push(warn, error);
    consoleLogger.warn("slow", { ms: 5 });
    consoleLogger.error("down");
    expect(warn).toHaveBeenCalledWith("[groundwork] slow", { ms: 5 });
    expect(error).toHaveBeenCalledWith("[groundwork] down");
  });

  test("drops debug and info", () => {
    expect(consoleLogger.debug).toBeUndefined();
    expect(consoleLogger.info).toBeUndefined();
  });
});
