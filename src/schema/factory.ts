import { type PgSchema, type PgTableFn, pgSchema, pgTable } from "drizzle-orm/pg-core";
import { GroundworkError } from "../internal/errors.ts";

/** The prefix used when none is given. */
export const DEFAULT_PREFIX = "gw_";

// Lower case only: Postgres folds unquoted names to lower case, so mixed case would force
// everyone to quote the tables in psql.
const PREFIX_PATTERN = /^[a-z_][a-z0-9_]*$/;
const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_IDENTIFIER_LENGTH = 63;

export interface TableFactoryOptions<TSchema extends string | undefined = string | undefined> {
  readonly prefix?: string | undefined;
  readonly schema?: TSchema;
}

/** Builds every groundwork table, so prefix, schema and naming rules are applied the same way. */
export interface TableFactory<TSchema extends string | undefined> {
  readonly prefix: string;
  /** The Postgres schema object, when a schema was configured. */
  readonly pgSchema: TSchema extends string ? PgSchema<TSchema> : undefined;
  /** `pgTable`, or `pgSchema(schema).table` when a schema was configured. */
  readonly table: PgTableFn<TSchema>;
  /** Applies the prefix to a table or index name and checks the result is a valid identifier. */
  name(base: string): string;
}

export function createTableFactory<TSchema extends string | undefined>(
  options: TableFactoryOptions<TSchema> = {},
): TableFactory<TSchema> {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  if (typeof prefix !== "string" || (prefix !== "" && !PREFIX_PATTERN.test(prefix))) {
    throw new GroundworkError(
      "invalid_config",
      `Invalid table prefix ${JSON.stringify(prefix)}: use lower-case letters, digits and underscores, starting with a letter or underscore (for example "gw_"), or "" for none.`,
    );
  }

  const schemaName = options.schema;
  if (schemaName !== undefined) {
    if (
      typeof schemaName !== "string" ||
      !SCHEMA_PATTERN.test(schemaName) ||
      schemaName.length > MAX_IDENTIFIER_LENGTH ||
      schemaName.startsWith("pg_")
    ) {
      throw new GroundworkError(
        "invalid_config",
        `Invalid schema ${JSON.stringify(schemaName)}: use lower-case letters, digits and underscores, at most ${MAX_IDENTIFIER_LENGTH} characters, not starting with "pg_".`,
      );
    }
  }

  const schema = schemaName === undefined ? undefined : pgSchema(schemaName);
  const table = (schema ? schema.table : pgTable) as PgTableFn<TSchema>;

  return {
    prefix,
    pgSchema: schema as TableFactory<TSchema>["pgSchema"],
    table,
    name(base) {
      const full = `${prefix}${base}`;
      if (full.length > MAX_IDENTIFIER_LENGTH) {
        throw new GroundworkError(
          "invalid_config",
          `Table prefix ${JSON.stringify(prefix)} is too long: "${full}" exceeds Postgres's ${MAX_IDENTIFIER_LENGTH}-character limit.`,
        );
      }
      return full;
    },
  };
}
