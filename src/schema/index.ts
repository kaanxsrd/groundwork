/**
 * `@vantedev/groundwork/schema`: table factories for your Drizzle schema.
 *
 * ```ts
 * // db/schema/groundwork.ts
 * import { groundworkTables } from "@vantedev/groundwork/schema";
 *
 * export const { rateLimits, auditLog, apiKeys, jobs, jobSchedules, idempotencyKeys } =
 *   groundworkTables();
 * ```
 *
 * Export the tables you use from a file drizzle-kit reads, and `drizzle-kit generate` creates the
 * migration. groundwork never runs DDL itself. Only exported tables are created, so destructure
 * just the ones you need.
 *
 * @module @vantedev/groundwork/schema
 */
import type { PgSchema } from "drizzle-orm/pg-core";
import { type ApiKeysTable, buildApiKeysTable } from "./api-keys.ts";
import { type AuditLogTable, buildAuditLogTable } from "./audit-log.ts";
import { createTableFactory, DEFAULT_PREFIX } from "./factory.ts";
import { buildIdempotencyKeysTable, type IdempotencyKeysTable } from "./idempotency-keys.ts";
import {
  buildJobSchedulesTable,
  buildJobsTable,
  type JobSchedulesTable,
  type JobsTable,
} from "./jobs.ts";
import { buildRateLimitsTable, type RateLimitsTable } from "./rate-limits.ts";

export type {
  ApiKeysTable,
  AuditLogTable,
  IdempotencyKeysTable,
  JobSchedulesTable,
  JobsTable,
  RateLimitsTable,
};
export { DEFAULT_PREFIX };

export interface GroundworkTablesOptions<TSchema extends string | undefined = undefined> {
  /**
   * Prepended to every table and index name. Defaults to `"gw_"`, so groundwork's tables never
   * clash with yours. Pass `""` for plain names.
   */
  readonly prefix?: string | undefined;
  /**
   * Postgres schema to create the tables in. Defaults to none, so they land in the connection's
   * `search_path` (usually `public`). When set, also export the returned `schema` so drizzle-kit
   * generates `CREATE SCHEMA`.
   */
  readonly schema?: TSchema;
}

/** Every groundwork table. Each module's table is added here as the module lands. */
export type GroundworkTables<TSchema extends string | undefined = undefined> = {
  readonly rateLimits: RateLimitsTable<TSchema>;
  readonly auditLog: AuditLogTable<TSchema>;
  readonly apiKeys: ApiKeysTable<TSchema>;
  readonly jobs: JobsTable<TSchema>;
  readonly jobSchedules: JobSchedulesTable<TSchema>;
  readonly idempotencyKeys: IdempotencyKeysTable<TSchema>;
} & (TSchema extends string
  ? {
      /** The Postgres schema. Export it too, or drizzle-kit won't generate `CREATE SCHEMA`. */
      readonly schema: PgSchema<TSchema>;
    }
  : unknown);

/**
 * Creates groundwork's tables with one prefix and schema.
 *
 * ```ts
 * export const { rateLimits } = groundworkTables({ prefix: "gw_" });
 * export const { schema: groundworkSchema, rateLimits } = groundworkTables({ schema: "ops" });
 * ```
 */
export function groundworkTables<const TSchema extends string | undefined = undefined>(
  options: GroundworkTablesOptions<TSchema> = {},
): GroundworkTables<TSchema> {
  const factory = createTableFactory<TSchema>(options);
  const tables = {
    rateLimits: buildRateLimitsTable(factory),
    auditLog: buildAuditLogTable(factory),
    apiKeys: buildApiKeysTable(factory),
    jobs: buildJobsTable(factory),
    jobSchedules: buildJobSchedulesTable(factory),
    idempotencyKeys: buildIdempotencyKeysTable(factory),
  };
  return (
    factory.pgSchema === undefined ? tables : { ...tables, schema: factory.pgSchema }
  ) as GroundworkTables<TSchema>;
}
