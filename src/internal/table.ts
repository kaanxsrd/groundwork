import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import { GroundworkError } from "./errors.ts";

/**
 * Checks at startup that `table` has the columns a module's SQL relies on, so passing the wrong
 * table fails with a clear message instead of a SQL error on the first request.
 */
export function assertTableColumns(
  table: Table,
  columns: readonly string[],
  expected: string,
): void {
  let names: string[];
  try {
    names = Object.values(getTableColumns(table)).map((column) => column.name);
  } catch {
    throw new GroundworkError("invalid_config", `table must be the ${expected}.`);
  }
  const missing = columns.filter((column) => !names.includes(column));
  if (missing.length > 0) {
    throw new GroundworkError(
      "invalid_config",
      `Table "${getTableName(table)}" is not the ${expected} (missing ${missing.join(", ")}).`,
    );
  }
}
