import { type SQL, sql } from "drizzle-orm";
import type { Clock } from "../internal/clock.ts";
import { type GroundworkDatabase, rowsOf, toNumber } from "../internal/db.ts";
import { parseDuration } from "../internal/duration.ts";
import { GroundworkError } from "../internal/errors.ts";
import { assertTableColumns } from "../internal/table.ts";
import { AUDIT_LOG_COLUMNS, type AuditLogTable } from "../schema/audit-log.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { createRedactor, DEFAULT_REDACT, type RedactRule, toJsonObject } from "./json.ts";
import type {
  AuditEntry,
  AuditEvent,
  AuditFilters,
  AuditLog,
  AuditPage,
  AuditQuery,
  RecordOptions,
} from "./types.ts";

export interface AuditLogOptions<TAction extends string, TEntity extends string> {
  /** Your Drizzle database. Entries go in `table`. */
  readonly db: GroundworkDatabase;
  /** The `auditLog` table from `groundworkTables()`. */
  readonly table: AuditLogTable;
  /** Every action your app records, such as `["post.create", "post.update"]`. Typed from this list. */
  readonly actions: readonly TAction[];
  /** Entity types, such as `["post", "user"]`. When given, `entity.type` is typed and checked too. */
  readonly entityTypes?: readonly TEntity[] | undefined;
  /**
   * Keys to replace with `"[redacted]"` anywhere in `changes` and `metadata`. A string matches any
   * key that contains it, ignoring case, `_` and `-`; a RegExp is tested against the raw key.
   * Added to `DEFAULT_REDACT` (password, secret, token, apiKey, authorization, cookie…).
   */
  readonly redact?: readonly RedactRule[] | undefined;
  /** Set to `false` to use only your own `redact` rules. Defaults to `true`. */
  readonly redactDefaults?: boolean | undefined;
  /** Time source for `occurredAt` and `prune()`. Defaults to Postgres's transaction time. */
  readonly clock?: Clock | undefined;
}

const MAX_BATCH = 1_000;
const MAX_LIMIT = 1_000;
const MAX_OFFSET = 100_000;
const PRUNE_BATCH = 5_000;

interface Row {
  id: unknown;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  changes: string | null;
  metadata: string | null;
  ip: string | null;
  request_id: string | null;
}

// occurred_at as UTC ISO text with microseconds, and JSON as text: identical across drivers.
const SELECT = sql.raw(
  `id::text as id, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at, actor_type, actor_id, actor_label, action, entity_type, entity_id, summary, changes::text as changes, metadata::text as metadata, ip, request_id`,
);

const INSERT_COLUMNS = sql.raw(
  "(occurred_at, actor_type, actor_id, actor_label, action, entity_type, entity_id, summary, changes, metadata, ip, request_id)",
);

function validateList(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new GroundworkError("invalid_config", `${label} must be a non-empty array of strings.`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value === "" || value.length > 200) {
      throw new GroundworkError(
        "invalid_config",
        `Invalid ${label} entry ${JSON.stringify(value)}: use a non-empty string of at most 200 characters.`,
      );
    }
    if (seen.has(value)) {
      throw new GroundworkError("invalid_config", `${label} lists "${value}" twice.`);
    }
    seen.add(value);
  }
  return values as string[];
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new GroundworkError("invalid_argument", `${label} must be a string.`);
}

function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new GroundworkError("invalid_argument", `${label} must be a string or a number.`);
}

const oneOrMany = <T>(value: T | readonly T[]): readonly T[] =>
  Array.isArray(value) ? (value as readonly T[]) : [value as T];

/** `column IN (…)`, or a false condition for an empty list. */
function inList(column: string, values: readonly (string | number)[]): SQL {
  if (values.length === 0) return sql`false`;
  return sql`${sql.raw(column)} in (${sql.join(
    values.map((value) => sql`${String(value)}::text`),
    sql`, `,
  )})`;
}

function validDate(value: unknown, label: string): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new GroundworkError("invalid_argument", `${label} must be a valid Date.`);
  }
  return value.toISOString();
}

function parseJson(text: string | null): Record<string, unknown> | null {
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

/**
 * Creates an append-only audit log in your Postgres.
 *
 * ```ts
 * const audit = createAuditLog({ db, table: auditLog, actions: ["post.create", "post.update"] });
 * await audit.record({ actor: { type: "user", id: user.id }, action: "post.update", changes: diff(before, after) }, { tx });
 * ```
 */
export function createAuditLog<const TAction extends string, const TEntity extends string = string>(
  options: AuditLogOptions<TAction, TEntity>,
): AuditLog<TAction, TEntity> {
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "createAuditLog needs an options object.");
  }
  const { db, table, clock } = options;
  if (!db || typeof db.execute !== "function") {
    throw new GroundworkError("invalid_config", "db must be a Drizzle Postgres database.");
  }
  assertTableColumns(table, AUDIT_LOG_COLUMNS, "auditLog table from groundworkTables()");
  const actions = new Set(validateList(options.actions, "actions"));
  const entityTypes =
    options.entityTypes === undefined
      ? null
      : new Set(validateList(options.entityTypes, "entityTypes"));
  const redact = createRedactor([
    ...(options.redactDefaults === false ? [] : DEFAULT_REDACT),
    ...(options.redact ?? []),
  ]);

  /** The decision's time: the injected clock, else Postgres's `now()` (the transaction's time). */
  const now = (): SQL => (clock ? sql`${clock.now().toISOString()}::timestamptz` : sql`now()`);

  function valuesFor(event: AuditEvent<TAction, TEntity>, index: number): SQL {
    const at = (label: string) => (index < 0 ? label : `events[${index}].${label}`);
    if (typeof event !== "object" || event === null) {
      throw new GroundworkError("invalid_argument", `${at("event")} must be an object.`);
    }
    const { actor, entity } = event;
    if (typeof actor !== "object" || actor === null) {
      throw new GroundworkError("invalid_argument", `${at("actor")} is required.`);
    }
    if (typeof actor.type !== "string" || actor.type === "") {
      throw new GroundworkError(
        "invalid_argument",
        `${at("actor.type")} must be a non-empty string.`,
      );
    }
    if (typeof event.action !== "string" || !actions.has(event.action)) {
      throw new GroundworkError(
        "invalid_argument",
        `Unknown audit action ${JSON.stringify(event.action)}: add it to actions.`,
      );
    }
    let entityType: string | null = null;
    let entityId: string | null = null;
    if (entity !== undefined && entity !== null) {
      if (typeof entity.type !== "string" || entity.type === "") {
        throw new GroundworkError(
          "invalid_argument",
          `${at("entity.type")} must be a non-empty string.`,
        );
      }
      if (entityTypes && !entityTypes.has(entity.type)) {
        throw new GroundworkError(
          "invalid_argument",
          `Unknown audit entity type ${JSON.stringify(entity.type)}: add it to entityTypes.`,
        );
      }
      entityType = entity.type;
      entityId = optionalId(entity.id, at("entity.id"));
    }
    // Redacted before anything is sent: secrets never reach the database or an error message.
    const changes = toJsonObject(event.changes, redact, at("changes"));
    const metadata = toJsonObject(event.metadata, redact, at("metadata"));
    const occurredAt =
      event.occurredAt === undefined
        ? now()
        : sql`${validDate(event.occurredAt, at("occurredAt"))}::timestamptz`;

    return sql`(${occurredAt}, ${actor.type}::text, ${optionalId(actor.id, at("actor.id"))}::text, ${optionalText(actor.label, at("actor.label"))}::text, ${event.action}::text, ${entityType}::text, ${entityId}::text, ${optionalText(event.summary, at("summary"))}::text, ${changes === null ? null : JSON.stringify(changes)}::jsonb, ${metadata === null ? null : JSON.stringify(metadata)}::jsonb, ${optionalText(event.ip, at("ip"))}::text, ${optionalText(event.requestId, at("requestId"))}::text)`;
  }

  function toEntry(row: Row): AuditEntry<TAction, TEntity> {
    return {
      id: toNumber(row.id),
      // Date keeps milliseconds; the cursor keeps the full value.
      occurredAt: new Date(`${row.occurred_at.slice(0, 23)}Z`),
      actor: { type: row.actor_type, id: row.actor_id, label: row.actor_label },
      action: row.action as TAction,
      entity:
        row.entity_type === null ? null : { type: row.entity_type as TEntity, id: row.entity_id },
      summary: row.summary,
      changes: parseJson(row.changes),
      metadata: parseJson(row.metadata),
      ip: row.ip,
      requestId: row.request_id,
    };
  }

  async function insert(
    values: SQL[],
    target: GroundworkDatabase,
  ): Promise<AuditEntry<TAction, TEntity>[]> {
    const rows = rowsOf<Row>(
      await target.execute(
        sql`insert into ${table} ${INSERT_COLUMNS} values ${sql.join(values, sql`, `)} returning ${SELECT}`,
      ),
    );
    // Identity values follow the VALUES order; sort so the result matches the input.
    return rows.map(toEntry).sort((a, b) => a.id - b.id);
  }

  function conditionsFor(filters: AuditFilters<TAction, TEntity>): SQL[] {
    if (typeof filters !== "object" || filters === null) {
      throw new GroundworkError("invalid_argument", "Audit filters must be an object.");
    }
    const conditions: SQL[] = [];
    if (filters.action !== undefined) conditions.push(inList("action", oneOrMany(filters.action)));
    if (filters.actorType !== undefined) {
      conditions.push(inList("actor_type", oneOrMany(filters.actorType)));
    }
    if (filters.actorId !== undefined) conditions.push(inList("actor_id", [filters.actorId]));
    if (filters.entity?.type !== undefined) {
      conditions.push(inList("entity_type", oneOrMany(filters.entity.type)));
    }
    if (filters.entity?.id !== undefined) {
      conditions.push(inList("entity_id", oneOrMany(filters.entity.id)));
    }
    if (filters.requestId !== undefined) conditions.push(inList("request_id", [filters.requestId]));
    if (filters.from !== undefined) {
      conditions.push(sql`occurred_at >= ${validDate(filters.from, "from")}::timestamptz`);
    }
    if (filters.to !== undefined) {
      conditions.push(sql`occurred_at < ${validDate(filters.to, "to")}::timestamptz`);
    }
    if (filters.search !== undefined && filters.search !== "") {
      if (typeof filters.search !== "string") {
        throw new GroundworkError("invalid_argument", "search must be a string.");
      }
      const pattern = `%${filters.search.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      conditions.push(
        sql`(summary ilike ${pattern} escape '!' or entity_id ilike ${pattern} escape '!' or actor_label ilike ${pattern} escape '!')`,
      );
    }
    if (filters.where !== undefined) conditions.push(sql`(${filters.where})`);
    return conditions;
  }

  const whereClause = (conditions: SQL[]): SQL =>
    conditions.length === 0 ? sql`` : sql`where ${sql.join(conditions, sql` and `)}`;

  return {
    actions: [...actions] as TAction[],

    async record(event, recordOptions?: RecordOptions) {
      const [entry] = await insert([valuesFor(event, -1)], recordOptions?.tx ?? db);
      if (!entry) throw new Error("audit insert returned no row");
      return entry;
    },

    async recordMany(events, recordOptions?: RecordOptions) {
      if (!Array.isArray(events)) {
        throw new GroundworkError("invalid_argument", "recordMany takes an array of events.");
      }
      if (events.length > MAX_BATCH) {
        throw new GroundworkError(
          "invalid_argument",
          `recordMany takes at most ${MAX_BATCH} events per call; got ${events.length}.`,
        );
      }
      if (events.length === 0) return [];
      // Validate everything before sending anything, so a bad event records none of them.
      const values = events.map((event, i) => valuesFor(event, i));
      return insert(values, recordOptions?.tx ?? db);
    },

    async query(query: AuditQuery<TAction, TEntity> = {}): Promise<AuditPage<TAction, TEntity>> {
      const conditions = conditionsFor(query);
      const order = query.order ?? "desc";
      if (order !== "asc" && order !== "desc") {
        throw new GroundworkError("invalid_argument", 'order must be "asc" or "desc".');
      }
      const limit = query.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new GroundworkError(
          "invalid_argument",
          `limit must be an integer from 1 to ${MAX_LIMIT}.`,
        );
      }
      const offset = query.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
        throw new GroundworkError(
          "invalid_argument",
          `offset must be an integer from 0 to ${MAX_OFFSET.toLocaleString("en-US")}. Page further with cursors.`,
        );
      }
      if (offset > 0 && query.cursor !== undefined && query.cursor !== null) {
        throw new GroundworkError("invalid_argument", "Pass offset or cursor, not both.");
      }
      if (query.cursor !== undefined && query.cursor !== null) {
        const position = decodeCursor(query.cursor);
        if (position.order !== order) {
          throw new GroundworkError(
            "invalid_argument",
            `This cursor came from an "${position.order}" query; pass the same order.`,
          );
        }
        // Row comparison on (occurred_at, id) uses the composite index and handles equal timestamps.
        const comparison = sql.raw(order === "desc" ? "<" : ">");
        conditions.push(
          sql`(occurred_at, id) ${comparison} (${position.occurredAt}::timestamptz, ${position.id}::bigint)`,
        );
      }
      const direction = sql.raw(order);
      // Qualified on purpose: a bare `id` in ORDER BY would mean the `id::text` output column and
      // sort ids as text ("99" after "100"), disagreeing with the numeric cursor comparison.
      const rows = rowsOf<Row>(
        await db.execute(
          sql`select ${SELECT} from ${table} ${whereClause(conditions)} order by ${table.occurredAt} ${direction}, ${table.id} ${direction} limit ${limit + 1} offset ${offset}`,
        ),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map(toEntry),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor({ order, occurredAt: last.occurred_at, id: toNumber(last.id) })
            : null,
      };
    },

    async count(filters: AuditFilters<TAction, TEntity> = {}) {
      const [row] = rowsOf<{ count: unknown }>(
        await db.execute(
          sql`select count(*)::text as count from ${table} ${whereClause(conditionsFor(filters))}`,
        ),
      );
      return row ? toNumber(row.count) : 0;
    },

    async prune(pruneOptions) {
      if (typeof pruneOptions !== "object" || pruneOptions === null) {
        throw new GroundworkError("invalid_argument", 'prune needs { olderThan }, such as "365d".');
      }
      const olderThanMs = parseDuration(pruneOptions.olderThan, { label: "olderThan", minMs: 1 });
      let total = 0;
      for (;;) {
        const [row] = rowsOf<{ deleted: unknown }>(
          await db.execute(sql`
            with input as materialized (
              select ${now()} - ${olderThanMs}::float8 * interval '1 millisecond' as cutoff
            ),
            doomed as (
              select id from ${table}, input
              where occurred_at < input.cutoff
              order by occurred_at, id
              limit ${PRUNE_BATCH}
            ),
            deleted as (
              delete from ${table} where id in (select id from doomed) returning 1
            )
            select count(*)::int as deleted from deleted`),
        );
        const deleted = row ? toNumber(row.deleted) : 0;
        total += deleted;
        if (deleted < PRUNE_BATCH) return total;
      }
    },
  };
}
