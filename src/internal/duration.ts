import { GroundworkError } from "./errors.ts";

/** Units accepted in a {@link Duration}. Months and years are left out because their length varies. */
export type DurationUnit = "ms" | "s" | "m" | "h" | "d" | "w";

/**
 * A length of time written as a number and a unit: `"500ms"`, `"30s"`, `"15m"`, `"24h"`, `"90d"`, `"2w"`.
 *
 * Bare numbers are not accepted, so `60` can never be misread as seconds when milliseconds were meant.
 * Build one from a variable with a template literal: `` `${days}d` ``.
 */
export type Duration = `${number}${DurationUnit}`;

const UNIT_MS: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/;

/**
 * The longest delay a timer can wait: Node and browsers run a `setTimeout` or `setInterval` above
 * 2^31 - 1 ms (about 24.8 days) after 1ms instead. Durations that drive a timer are capped here.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export interface ParseDurationOptions {
  /** Name of the option being parsed, used in the error message (for example `"window"`). */
  readonly label?: string;
  /** Smallest accepted value in milliseconds. Defaults to 0. */
  readonly minMs?: number;
  /** Largest accepted value in milliseconds, such as {@link MAX_TIMER_MS}. Defaults to none. */
  readonly maxMs?: number;
}

/** Whether `value` is a well-formed {@link Duration} string. */
export function isDuration(value: unknown): value is Duration {
  return typeof value === "string" && DURATION_PATTERN.test(value);
}

/**
 * Converts a {@link Duration} to whole milliseconds.
 *
 * Throws a `GroundworkError` with code `invalid_argument` for anything malformed, negative,
 * below `minMs`, or too large to be represented exactly.
 */
export function parseDuration(value: Duration, options: ParseDurationOptions = {}): number {
  const label = options.label ?? "duration";
  const match = typeof value === "string" ? DURATION_PATTERN.exec(value) : null;
  if (!match) {
    throw new GroundworkError(
      "invalid_argument",
      `Invalid ${label} ${JSON.stringify(value)}: use a number followed by ms, s, m, h, d or w (for example "15m").`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2] as DurationUnit;
  const ms = Math.round(amount * UNIT_MS[unit]);
  if (!Number.isSafeInteger(ms)) {
    throw new GroundworkError("invalid_argument", `Invalid ${label} "${value}": it is too large.`);
  }
  const minMs = options.minMs ?? 0;
  if (ms < minMs) {
    throw new GroundworkError(
      "invalid_argument",
      `Invalid ${label} "${value}": it must be at least ${minMs}ms.`,
    );
  }
  if (options.maxMs !== undefined && ms > options.maxMs) {
    throw new GroundworkError(
      "invalid_argument",
      options.maxMs === MAX_TIMER_MS
        ? `Invalid ${label} "${value}": it can be at most 24 days, the longest a timer can wait.`
        : `Invalid ${label} "${value}": it can be at most ${options.maxMs}ms.`,
    );
  }
  return ms;
}
