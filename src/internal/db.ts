import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

/**
 * Any Drizzle Postgres database or transaction, whichever driver created it (`postgres`, `pg`,
 * Neon, PGlite…) and whatever schema it was given. groundwork only needs `execute()`, so it never
 * depends on a particular driver's result types.
 */
export interface GroundworkDatabase {
  execute(query: SQLWrapper): PromiseLike<unknown>;
}

/**
 * A `jsonb` parameter from JSON text (`null` is SQL `NULL`). The text travels as a `text`
 * parameter and Postgres casts it, because drivers don't agree on `jsonb` parameters: postgres-js
 * runs `JSON.stringify` on anything the server says is `jsonb`, so already-encoded JSON would be
 * stored as a JSON string. Drizzle 0.45 turned that serializer off on every postgres-js client it
 * wrapped; Drizzle 1.0 doesn't. A `text` parameter is sent unchanged by every driver.
 */
export function jsonbParam(json: string | null): SQL {
  return sql`${json}::text::jsonb`;
}

/**
 * Normalises `db.execute()` results: postgres-js returns an array, node-postgres `{ rows }`.
 *
 * It also undoes postgres-js's built-in column transforms (`postgres.camel`, `postgres.pascal`,
 * `postgres.kebab`), which an app may have set on its client: `used_at` comes back as `usedAt`,
 * `UsedAt` or `used-at`. Every column groundwork reads is lower snake_case with no underscore
 * before a digit, so the transforms can be reversed exactly. They also rename keys inside `json`
 * and `jsonb` values, which is why groundwork returns JSON as text.
 */
export function rowsOf<T>(result: unknown): T[] {
  const rows = rawRows(result);
  const first = rows[0];
  if (first === undefined || !Object.keys(first as object).some(isTransformed)) return rows as T[];
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as object)) out[snakeCase(key)] = value;
    return out as T;
  });
}

function rawRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result !== null && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows;
  }
  throw new TypeError("Unexpected result from db.execute(): expected an array or { rows }.");
}

const isTransformed = (key: string) => /[A-Z-]/.test(key);

/** `usedAt`, `UsedAt` and `used-at` all become `used_at`. */
function snakeCase(key: string): string {
  return key
    .replaceAll("-", "_")
    .replace(/[A-Z]/g, (letter, index: number) => (index === 0 ? "" : "_") + letter.toLowerCase());
}

/** Postgres's error code, whether the driver or Drizzle wrapped it. */
export function pgCode(error: unknown): string | undefined {
  const own = (error as { code?: unknown })?.code;
  if (typeof own === "string") return own;
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
  return typeof cause === "string" ? cause : undefined;
}

/** Postgres's own message, without the "Failed query: …" Drizzle wraps it in. */
export function pgMessage(error: unknown): string {
  const own = typeof (error as { code?: unknown })?.code === "string";
  const source = own ? error : ((error as { cause?: unknown })?.cause ?? error);
  return source instanceof Error ? source.message : String(source);
}

/** Reads a numeric column that a driver may return as a number, a string or a bigint. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" || typeof value === "bigint") return Number(value);
  throw new TypeError(`Expected a number from the database, got ${typeof value}.`);
}
