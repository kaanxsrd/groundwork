/**
 * `@vante/groundwork/testing`: helpers for testing apps that use groundwork.
 *
 * @module
 */
import type { Clock } from "../internal/clock.ts";
import { type Duration, parseDuration } from "../internal/duration.ts";
import { GroundworkError } from "../internal/errors.ts";

/** A clock that only moves when you move it. */
export interface TestClock extends Clock {
  /** Moves forward by a duration, or by a number of milliseconds. Returns the new time. */
  advance(by: Duration | number): Date;
  /** Jumps to a time (a `Date`, epoch milliseconds or an ISO string). Returns it. */
  set(to: Date | number | string): Date;
}

function toTime(value: Date | number | string): number {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) {
    throw new GroundworkError("invalid_argument", `Invalid time ${JSON.stringify(value)}.`);
  }
  return time;
}

/**
 * Creates a clock for tests. Pass it as `clock` to groundwork modules, then move time yourself:
 *
 * ```ts
 * const clock = createTestClock("2026-01-01T00:00:00Z");
 * const limiter = createRateLimiter({ db, table, secret, clock });
 * clock.advance("15m");
 * ```
 */
export function createTestClock(
  start: Date | number | string = "2026-01-01T00:00:00.000Z",
): TestClock {
  let now = toTime(start);
  return {
    now: () => new Date(now),
    advance(by) {
      const ms = typeof by === "number" ? by : parseDuration(by, { label: "advance" });
      if (!Number.isFinite(ms) || ms < 0) {
        throw new GroundworkError(
          "invalid_argument",
          "A test clock only moves forward; use set() to jump back.",
        );
      }
      now += ms;
      return new Date(now);
    },
    set(to) {
      now = toTime(to);
      return new Date(now);
    },
  };
}
