import type { SQLWrapper } from "drizzle-orm";

/**
 * Any Drizzle Postgres database or transaction, whichever driver created it (`postgres`, `pg`,
 * Neon, PGlite…) and whatever schema it was given. groundwork only needs `execute()`, so it never
 * depends on a particular driver's result types.
 */
export interface GroundworkDatabase {
  execute(query: SQLWrapper): PromiseLike<unknown>;
}

/** Normalises `db.execute()` results: postgres-js returns an array, node-postgres `{ rows }`. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result !== null && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  throw new TypeError("Unexpected result from db.execute(): expected an array or { rows }.");
}

/** Reads a numeric column that a driver may return as a number, a string or a bigint. */
export function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" || typeof value === "bigint") return Number(value);
  throw new TypeError(`Expected a number from the database, got ${typeof value}.`);
}
