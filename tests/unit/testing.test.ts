import { describe, expect, test } from "bun:test";
import { createTestClock } from "../../src/testing/index.ts";

describe("createTestClock", () => {
  test("starts at a fixed time and only moves when told to", () => {
    const clock = createTestClock();
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.advance("15m").toISOString()).toBe("2026-01-01T00:15:00.000Z");
    expect(clock.advance(250).toISOString()).toBe("2026-01-01T00:15:00.250Z");
    expect(clock.set("2030-06-01T12:00:00Z").toISOString()).toBe("2030-06-01T12:00:00.000Z");
    expect(clock.set(0).getTime()).toBe(0);
  });

  test("hands out copies, so callers can't move it by accident", () => {
    const clock = createTestClock(1_000);
    clock.now().setTime(0);
    expect(clock.now().getTime()).toBe(1_000);
  });

  test("refuses to go backwards with advance, or to an invalid time", () => {
    const clock = createTestClock();
    expect(() => clock.advance(-1)).toThrow(/only moves forward/);
    expect(() => clock.advance("soon" as never)).toThrow(/Invalid advance/);
    expect(() => clock.set("not a date")).toThrow(/Invalid time/);
    expect(() => createTestClock("nope")).toThrow(/Invalid time/);
  });
});
