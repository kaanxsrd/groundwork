import { GroundworkError } from "../internal/errors.ts";

/**
 * A position in the log. `occurredAt` keeps Postgres's microseconds: a JS Date only has
 * milliseconds, and rounding would make the keyset comparison skip or repeat entries that
 * share a millisecond.
 */
export interface CursorPosition {
  readonly order: "asc" | "desc";
  readonly occurredAt: string;
  readonly id: number;
}

const VERSION = "a1";
const MICROS_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify([VERSION, position.order, position.occurredAt, position.id]),
  ).toString("base64url");
}

export function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    Array.isArray(parsed) &&
    parsed.length === 4 &&
    parsed[0] === VERSION &&
    (parsed[1] === "asc" || parsed[1] === "desc") &&
    typeof parsed[2] === "string" &&
    MICROS_ISO.test(parsed[2]) &&
    Number.isSafeInteger(parsed[3])
  ) {
    return { order: parsed[1], occurredAt: parsed[2], id: parsed[3] as number };
  }
  throw new GroundworkError(
    "invalid_argument",
    "Invalid audit cursor: pass the nextCursor from a previous query() unchanged.",
  );
}
