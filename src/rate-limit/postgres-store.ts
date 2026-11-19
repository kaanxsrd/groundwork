import { type SQL, sql } from "drizzle-orm";
import { type GroundworkDatabase, rowsOf, toNumber } from "../internal/db.ts";
import { GroundworkError } from "../internal/errors.ts";
import { assertTableColumns } from "../internal/table.ts";
import { RATE_LIMIT_COLUMNS, type RateLimitsTable } from "../schema/rate-limits.ts";
import { EPSILON } from "./policy.ts";
import type { ConsumeInput, RateLimitStore, ResetOptions, StoreState } from "./types.ts";

export interface PostgresStoreOptions {
  readonly db: GroundworkDatabase;
  /** The `rateLimits` table from `groundworkTables()`. */
  readonly table: RateLimitsTable;
}

const CLEANUP_BATCH = 5_000;

interface ConsumeRow {
  allowed: boolean;
  used: unknown;
  updated_at: unknown;
  expires_at: unknown;
  now: unknown;
}

/** Epoch milliseconds as float8, which every driver returns as a JS number. */
const ms = (column: SQL): SQL => sql`(extract(epoch from ${column}) * 1000)::float8`;

/** The decision's time: the injected clock if there is one, else the database's. */
const nowParam = (now: number | null): SQL =>
  sql`coalesce(${now === null ? null : new Date(now).toISOString()}::timestamptz, clock_timestamp())`;

/**
 * One statement per check:
 *
 * 1. `consumed` upserts the row only if the cost fits. `ON CONFLICT … DO UPDATE … WHERE` locks the
 *    existing row and re-checks against its latest committed version, so concurrent checks for
 *    the same subject serialise on that row and can never overspend.
 * 2. If nothing was consumed, the outer query reads the current row instead, so a denial still
 *    reports remaining and reset times without a second round trip.
 */
function consumeQuery(table: RateLimitsTable, input: ConsumeInput): SQL {
  const { policy, key, rule, cost } = input;
  const capacity = policy.algorithm === "fixed-window" ? policy.limit : policy.burst;

  let insertExpires: SQL;
  let setClause: SQL;
  let fitsExisting: SQL;
  if (policy.algorithm === "fixed-window") {
    // At or after expires_at the window is over: the row counts as empty and a new window starts.
    const over = sql`r.expires_at <= excluded.updated_at`;
    insertExpires = sql`input.now + ${policy.windowMs}::float8 * interval '1 millisecond'`;
    setClause = sql`
      used = case when ${over} then excluded.used else r.used + excluded.used end,
      expires_at = case when ${over} then excluded.expires_at else r.expires_at end,
      updated_at = excluded.updated_at,
      rule = excluded.rule`;
    fitsExisting = sql`(case when ${over} then 0 else r.used end) + excluded.used <= ${capacity}::float8 + ${EPSILON}::float8`;
  } else {
    const rate = sql`${policy.ratePerMs}::float8`;
    // Tokens still taken after refilling for the time since updated_at (never negative).
    const drained = sql`greatest(0::float8, r.used - greatest(0::float8, extract(epoch from (excluded.updated_at - r.updated_at))::float8 * 1000) * ${rate})`;
    insertExpires = sql`input.now + (${cost}::float8 / ${rate}) * interval '1 millisecond'`;
    setClause = sql`
      used = ${drained} + excluded.used,
      updated_at = excluded.updated_at,
      expires_at = excluded.updated_at + ((${drained} + excluded.used) / ${rate}) * interval '1 millisecond',
      rule = excluded.rule`;
    fitsExisting = sql`${drained} + excluded.used <= ${capacity}::float8 + ${EPSILON}::float8`;
  }

  return sql`
    with input as materialized (
      select ${nowParam(input.now)} as now
    ),
    consumed as (
      insert into ${table} as r (key, rule, used, updated_at, expires_at)
      select ${key}::text, ${rule}::text, ${cost}::float8, input.now, ${insertExpires}
      from input
      where ${cost}::float8 <= ${capacity}::float8 + ${EPSILON}::float8
      on conflict (key) do update set ${setClause}
      where ${fitsExisting}
      returning r.used, r.updated_at, r.expires_at
    )
    select
      (c.used is not null) as allowed,
      coalesce(c.used, existing.used) as used,
      ${ms(sql`coalesce(c.updated_at, existing.updated_at)`)} as updated_at,
      ${ms(sql`coalesce(c.expires_at, existing.expires_at)`)} as expires_at,
      ${ms(sql`input.now`)} as now
    from input
    left join consumed c on true
    left join ${table} existing on c.used is null and existing.key = ${key}::text`;
}

/** The default store: counters in your Postgres, in the table from `groundworkTables()`. */
export function postgresStore(
  options: PostgresStoreOptions,
): RateLimitStore & { kind: "postgres" } {
  const { db, table } = options;
  if (!db || typeof db.execute !== "function") {
    throw new GroundworkError("invalid_config", "db must be a Drizzle Postgres database.");
  }
  assertTableColumns(table, RATE_LIMIT_COLUMNS, "rateLimits table from groundworkTables()");

  return {
    kind: "postgres",
    async consume(input): Promise<StoreState> {
      const [row] = rowsOf<ConsumeRow>(await db.execute(consumeQuery(table, input)));
      if (!row) throw new Error("rate-limit query returned no row");
      const now = toNumber(row.now);
      if (row.used === null || row.used === undefined) return { allowed: false, now, row: null };
      return {
        allowed: row.allowed === true,
        now,
        row: {
          used: toNumber(row.used),
          updatedAt: toNumber(row.updated_at),
          expiresAt: toNumber(row.expires_at),
        },
      };
    },
    async reset(key, resetOptions?: ResetOptions) {
      const target = resetOptions?.tx ?? db;
      await target.execute(sql`delete from ${table} where key = ${key}::text`);
    },
    async cleanup(now) {
      let total = 0;
      for (;;) {
        // Skip rows other checks are updating right now; re-check expiry on the row we delete.
        const [row] = rowsOf<{ deleted: unknown }>(
          await db.execute(sql`
            with input as materialized (select ${nowParam(now)} as now),
            doomed as (
              select candidate.key from ${table} candidate, input
              where candidate.expires_at <= input.now
              limit ${CLEANUP_BATCH}
              for update of candidate skip locked
            ),
            deleted as (
              delete from ${table} t using doomed, input
              where t.key = doomed.key and t.expires_at <= input.now
              returning 1
            )
            select count(*)::int as deleted from deleted`),
        );
        const deleted = row ? toNumber(row.deleted) : 0;
        total += deleted;
        if (deleted < CLEANUP_BATCH) return total;
      }
    },
  };
}
