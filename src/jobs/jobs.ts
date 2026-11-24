import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type SQL, sql } from "drizzle-orm";
import { toJsonValue } from "../audit/json.ts";
import type { Clock } from "../internal/clock.ts";
import { type GroundworkDatabase, jsonbParam, rowsOf, toNumber } from "../internal/db.ts";
import { type Duration, isDuration, MAX_TIMER_MS, parseDuration } from "../internal/duration.ts";
import { errorText, GroundworkError, isGroundworkError } from "../internal/errors.ts";
import { renewEveryMs } from "../internal/lease.ts";
import { consoleLogger, createOnceLogger, type Logger } from "../internal/logger.ts";
import { type StandardSchemaV1, validateWith } from "../internal/standard-schema.ts";
import { assertTableColumns } from "../internal/table.ts";
import {
  JOB_COLUMNS,
  JOB_SCHEDULE_COLUMNS,
  type JobSchedulesTable,
  type JobsTable,
} from "../schema/jobs.ts";
import { backoffDelayMs, ladderDelayMs } from "./backoff.ts";
import type {
  EnqueueManyItem,
  EnqueueManyOptions,
  EnqueueOptions,
  EnqueueResult,
  JobContext,
  JobFailure,
  JobHandle,
  JobListFilter,
  JobRecord,
  JobStatus,
  Jobs,
  JobsHealth,
  RunOnceOptions,
  RunSummary,
  ScheduleContext,
  ScheduleOptions,
  WorkOptions,
} from "./types.ts";

export interface JobsOptions {
  readonly db: GroundworkDatabase;
  /** The `jobs` table from `groundworkTables()`. */
  readonly table: JobsTable;
  /** The `jobSchedules` table from `groundworkTables()`. */
  readonly schedulesTable: JobSchedulesTable;
  /**
   * How long a claimed job is reserved for its worker. Workers renew it while the job runs, so a
   * job is only picked up again if its worker stops (a crash, a kill, a lost connection). Defaults
   * to `"1m"`.
   */
  readonly lease?: Duration | undefined;
  /** Identifies this worker in `locked_by`. Defaults to `<hostname>:<pid>:<random>`. */
  readonly workerId?: string | undefined;
  /** Defaults to Postgres's time. Inject one in tests. */
  readonly clock?: Clock | undefined;
  /** Defaults to `console` (warnings and errors only). */
  readonly logger?: Logger | undefined;
  /** For tests: the random source for backoff jitter. Defaults to `Math.random`. */
  readonly random?: (() => number) | undefined;
}

const NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;
const SCHEDULE_PREFIX = "schedule:";
const MAX_LIST = 1_000;
const MAX_ENQUEUE_MANY = 1_000;
const PRUNE_BATCH = 5_000;
const MAX_ERROR_LENGTH = 2_000;
const MAX_BACKOFF_STEPS = 100;
/** A schedule's tick may run this early at most (and never more than a tenth of `every`). */
const SCHEDULE_EARLY_MAX_MS = 5_000;

interface Handler {
  readonly type: string;
  readonly schema: StandardSchemaV1 | undefined;
  readonly run: (payload: unknown, context: JobContext) => unknown;
  readonly onExhausted:
    | ((payload: unknown, failure: JobFailure, context: JobContext) => unknown)
    | undefined;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** A fixed retry ladder, used instead of base and max when set. */
  readonly backoffDelaysMs: readonly number[] | null;
  readonly timeoutMs: number | null;
  readonly priority: number;
  /** Set for schedule jobs: the schedule's name. */
  readonly schedule: string | undefined;
}

interface ScheduleEntry {
  readonly name: string;
  readonly every: Duration;
  readonly everyMs: number;
  readonly maxAttempts: number;
}

interface StoredJob {
  id: string;
  type: string;
  payload: unknown;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: number;
  locked_until: number | null;
  locked_by: string | null;
  dedupe_key: string | null;
  last_error: string | null;
  result: unknown;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

const ms = (column: string) => `(extract(epoch from ${column}) * 1000)::float8`;

const RECORD = sql.raw(`jsonb_build_object(
  'id', j.id::text, 'type', j.type, 'payload', j.payload, 'status', j.status, 'priority', j.priority,
  'attempts', j.attempts, 'max_attempts', j.max_attempts, 'run_at', ${ms("j.run_at")},
  'locked_until', ${ms("j.locked_until")}, 'locked_by', j.locked_by, 'dedupe_key', j.dedupe_key,
  'last_error', j.last_error, 'result', j.result, 'created_at', ${ms("j.created_at")},
  'started_at', ${ms("j.started_at")}, 'completed_at', ${ms("j.completed_at")}, 'updated_at', ${ms("j.updated_at")}
)::text`);

const toDate = (value: number | null) => (value === null ? null : new Date(value));

/** When a schedule's tick was due: its payload's `scheduledAt`, or the job's creation if that's missing. */
function scheduledAtOf(job: StoredJob): Date {
  const stored = (job.payload as { scheduledAt?: unknown } | null)?.scheduledAt;
  const at = typeof stored === "string" ? new Date(stored) : new Date(Number.NaN);
  return Number.isNaN(at.getTime()) ? new Date(job.created_at) : at;
}

function toRecord(row: StoredJob): JobRecord {
  return {
    id: row.id,
    type: row.type,
    schedule: row.type.startsWith(SCHEDULE_PREFIX) ? row.type.slice(SCHEDULE_PREFIX.length) : null,
    status: row.status,
    payload: row.payload,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: new Date(row.run_at),
    lockedUntil: toDate(row.locked_until),
    lockedBy: row.locked_by,
    dedupeKey: row.dedupe_key,
    lastError: row.last_error,
    result: row.result,
    createdAt: new Date(row.created_at),
    startedAt: toDate(row.started_at),
    completedAt: toDate(row.completed_at),
    updatedAt: new Date(row.updated_at),
  };
}

function validateName(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new GroundworkError(
      "invalid_config",
      `Invalid ${label} ${JSON.stringify(value)}: use 1 to 100 letters, digits or _ . : - (for example "email.receipt").`,
    );
  }
  return value;
}

function positiveInt(
  value: unknown,
  label: string,
  code: "invalid_config" | "invalid_argument",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GroundworkError(code, `${label} must be a positive integer.`);
  }
  return value as number;
}

function integer(
  value: unknown,
  label: string,
  code: "invalid_config" | "invalid_argument",
): number {
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 1_000_000) {
    throw new GroundworkError(
      code,
      `${label} must be an integer between -1,000,000 and 1,000,000.`,
    );
  }
  return value as number;
}

/**
 * Creates background jobs and schedules on your Postgres.
 *
 * ```ts
 * const jobs = createJobs({ db, table: tables.jobs, schedulesTable: tables.jobSchedules });
 * export const sendReceipt = jobs.define("email.receipt", {
 *   schema: z.object({ orderId: z.string() }),
 *   async run({ orderId }, { signal }) { await mailer.send(orderId, { signal }); },
 * });
 * await sendReceipt.enqueue({ orderId }, { tx, dedupeKey: `receipt:${orderId}` });
 * await jobs.work({ signal });
 * ```
 */
export function createJobs(options: JobsOptions): Jobs {
  if (typeof options !== "object" || options === null) {
    throw new GroundworkError("invalid_config", "createJobs needs an options object.");
  }
  const { db, table, schedulesTable, clock } = options;
  if (!db || typeof db.execute !== "function") {
    throw new GroundworkError("invalid_config", "db must be a Drizzle Postgres database.");
  }
  assertTableColumns(table, JOB_COLUMNS, "jobs table from groundworkTables()");
  assertTableColumns(
    schedulesTable,
    JOB_SCHEDULE_COLUMNS,
    "jobSchedules table from groundworkTables()",
  );
  const leaseMs = parseDuration(options.lease ?? "1m", {
    label: "lease",
    minMs: 1_000,
    maxMs: MAX_TIMER_MS,
  });
  const workerId =
    options.workerId ?? `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
  if (typeof workerId !== "string" || workerId === "") {
    throw new GroundworkError("invalid_config", "workerId must be a non-empty string.");
  }
  const random = options.random ?? Math.random;
  const logger = options.logger ?? consoleLogger;
  const once = createOnceLogger(logger);

  const handlers = new Map<string, Handler>();
  const schedules = new Map<string, ScheduleEntry>();
  let schedulesSynced = false;

  /** The time a statement works with: the injected clock, else Postgres's `now()`. */
  const now = (): SQL => (clock ? sql`${clock.now().toISOString()}::timestamptz` : sql`now()`);
  const lease = sql`${leaseMs}::float8 * interval '1 millisecond'`;

  function addHandler(
    type: string,
    definition: Record<string, unknown>,
    defaults: { maxAttempts: number; base: Duration; max: Duration; timeout: Duration },
    schedule?: string,
  ): Handler {
    if (handlers.has(type)) {
      throw new GroundworkError(
        "invalid_config",
        `Job type "${type}" is already defined; define each type once.`,
      );
    }
    if (typeof definition.run !== "function") {
      throw new GroundworkError("invalid_config", `Job type "${type}" needs a run function.`);
    }
    const schema = definition.schema as StandardSchemaV1 | undefined;
    if (schema !== undefined && typeof schema?.["~standard"]?.validate !== "function") {
      throw new GroundworkError(
        "invalid_config",
        `The schema of job type "${type}" isn't a Standard Schema (zod, valibot, arktype…).`,
      );
    }
    if (definition.onExhausted !== undefined && typeof definition.onExhausted !== "function") {
      throw new GroundworkError(
        "invalid_config",
        `onExhausted of job type "${type}" must be a function.`,
      );
    }
    const backoff = (definition.backoff ?? {}) as {
      base?: unknown;
      max?: unknown;
      delays?: unknown;
    };
    let backoffDelaysMs: number[] | null = null;
    if (backoff.delays !== undefined) {
      if (backoff.base !== undefined || backoff.max !== undefined) {
        throw new GroundworkError(
          "invalid_config",
          `backoff of "${type}" takes either delays, or base and max, not both.`,
        );
      }
      if (
        !Array.isArray(backoff.delays) ||
        backoff.delays.length === 0 ||
        backoff.delays.length > MAX_BACKOFF_STEPS
      ) {
        throw new GroundworkError(
          "invalid_config",
          `backoff.delays of "${type}" must be a list of 1 to ${MAX_BACKOFF_STEPS} durations, such as ["30s", "2m", "1h"].`,
        );
      }
      backoffDelaysMs = backoff.delays.map((delay: unknown, index: number) =>
        parseDuration(delay as Duration, { label: `backoff.delays[${index}] of "${type}"` }),
      );
    }
    const timeout = definition.timeout === undefined ? defaults.timeout : definition.timeout;
    const handler: Handler = {
      type,
      schema,
      run: definition.run as Handler["run"],
      onExhausted: definition.onExhausted as Handler["onExhausted"],
      maxAttempts:
        definition.maxAttempts === undefined
          ? defaults.maxAttempts
          : positiveInt(definition.maxAttempts, `maxAttempts of "${type}"`, "invalid_config"),
      backoffBaseMs: parseDuration((backoff.base ?? defaults.base) as Duration, {
        label: `backoff.base of "${type}"`,
      }),
      backoffMaxMs: parseDuration((backoff.max ?? defaults.max) as Duration, {
        label: `backoff.max of "${type}"`,
      }),
      backoffDelaysMs,
      timeoutMs:
        timeout === false
          ? null
          : parseDuration(timeout as Duration, {
              label: `timeout of "${type}"`,
              minMs: 1,
              maxMs: MAX_TIMER_MS,
            }),
      priority:
        definition.priority === undefined
          ? 0
          : integer(definition.priority, `priority of "${type}"`, "invalid_config"),
      schedule,
    };
    handlers.set(type, handler);
    return handler;
  }

  async function payloadFor(handler: Handler, payload: unknown): Promise<unknown> {
    if (handler.schema) {
      const checked = await validateWith(handler.schema, payload);
      if (!checked.ok) {
        throw new GroundworkError(
          "invalid_argument",
          `Invalid payload for job type "${handler.type}": ${checked.message}`,
        );
      }
    }
    return toJsonValue(payload);
  }

  /** A job checked and ready to insert. `runAt` and `delayMs` are both null for "now". */
  interface Prepared {
    readonly json: unknown;
    readonly priority: number;
    readonly maxAttempts: number;
    readonly dedupeKey: string | null;
    readonly runAt: Date | null;
    readonly delayMs: number | null;
  }

  /** Validates one job's payload and options, as `enqueue` and `enqueueMany` both need. */
  async function prepare(
    handler: Handler,
    payload: unknown,
    enqueueOptions: Omit<EnqueueOptions, "tx">,
  ): Promise<Prepared> {
    const json = await payloadFor(handler, payload);
    const priority =
      enqueueOptions.priority === undefined
        ? handler.priority
        : integer(enqueueOptions.priority, "priority", "invalid_argument");
    const maxAttempts =
      enqueueOptions.maxAttempts === undefined
        ? handler.maxAttempts
        : positiveInt(enqueueOptions.maxAttempts, "maxAttempts", "invalid_argument");
    const dedupeKey = enqueueOptions.dedupeKey ?? null;
    if (
      dedupeKey !== null &&
      (typeof dedupeKey !== "string" || dedupeKey === "" || dedupeKey.length > 500)
    ) {
      throw new GroundworkError(
        "invalid_argument",
        "dedupeKey must be a non-empty string of at most 500 characters.",
      );
    }
    if (enqueueOptions.runAt !== undefined && enqueueOptions.delay !== undefined) {
      throw new GroundworkError("invalid_argument", "Pass runAt or delay, not both.");
    }
    let runAt: Date | null = null;
    let delayMs: number | null = null;
    if (enqueueOptions.runAt !== undefined) {
      if (!(enqueueOptions.runAt instanceof Date) || Number.isNaN(enqueueOptions.runAt.getTime())) {
        throw new GroundworkError("invalid_argument", "runAt must be a valid Date.");
      }
      runAt = enqueueOptions.runAt;
    } else if (enqueueOptions.delay !== undefined) {
      delayMs = parseDuration(enqueueOptions.delay, { label: "delay" });
    }
    return { json, priority, maxAttempts, dedupeKey, runAt, delayMs };
  }

  async function enqueue(
    handler: Handler,
    payload: unknown,
    enqueueOptions: EnqueueOptions = {},
  ): Promise<EnqueueResult> {
    const replace = enqueueOptions.replace ?? false;
    if (typeof replace !== "boolean") {
      throw new GroundworkError("invalid_argument", "replace must be true or false.");
    }
    const prepared = await prepare(handler, payload, enqueueOptions);
    const { json, priority, maxAttempts, dedupeKey, ...when } = prepared;
    const runAt: SQL =
      when.runAt !== null
        ? sql`${when.runAt.toISOString()}::timestamptz`
        : when.delayMs !== null
          ? sql`input.now + ${when.delayMs}::float8 * interval '1 millisecond'`
          : sql`input.now`;

    const target = enqueueOptions.tx ?? db;
    if (replace) {
      if (dedupeKey === null) {
        throw new GroundworkError(
          "invalid_argument",
          "replace needs a dedupeKey: it replaces the pending job with that key.",
        );
      }
      return enqueueReplacing(handler, prepared, dedupeKey, runAt, target);
    }
    const rows = rowsOf<{ id: string; created: boolean }>(
      await target.execute(sql`
        with input as materialized (select ${now()} as now),
        inserted as (
          insert into ${table} as j (type, payload, priority, max_attempts, run_at, dedupe_key, created_at, updated_at)
          select ${handler.type}::text, ${jsonbParam(JSON.stringify(json))}, ${priority}::int, ${maxAttempts}::int,
            ${runAt}, ${dedupeKey}::text, input.now, input.now
          from input
          on conflict (type, dedupe_key) where dedupe_key is not null and status in ('pending', 'running') do nothing
          returning j.id::text as id
        )
        select id, true as created from inserted
        union all
        select j.id::text, false from ${table} j
        where ${dedupeKey}::text is not null and j.type = ${handler.type}::text and j.dedupe_key = ${dedupeKey}::text
          and j.status in ('pending', 'running') and not exists (select 1 from inserted)
        limit 1`),
    );
    const row = rows[0];
    if (row) return { id: row.id, created: row.created === true };
    // The duplicate committed after this statement's snapshot was taken: look it up again.
    const [existing] = rowsOf<{ id: string }>(
      await target.execute(
        sql`select id::text as id from ${table} where type = ${handler.type}::text and dedupe_key = ${dedupeKey}::text and status in ('pending', 'running') limit 1`,
      ),
    );
    if (!existing)
      throw new Error("enqueue found neither a new job nor the duplicate it collided with");
    return { id: existing.id, created: false };
  }

  /**
   * `enqueue` with `replace`, to debounce, as graphile-worker's "replace" mode does:
   *
   * - A pending job with the key gets this call's payload, timing, priority and maxAttempts. It
   *   keeps its id and its attempt count, which only ever grows because it fences workers.
   * - So does a running job whose lease ran out (its worker is gone): it goes back to pending,
   *   so the old worker can no longer finish it.
   * - A running job that's alive keeps running, but gives up the key, and a new job is enqueued.
   *   Its payload may be out of date, and dropping this call would lose the latest one.
   *
   * The first statement replaces or inserts. If it does neither, a live running job holds the
   * key: the second statement takes the key from it, and the first runs again.
   */
  async function enqueueReplacing(
    handler: Handler,
    job: Prepared,
    dedupeKey: string,
    runAt: SQL,
    target: GroundworkDatabase,
  ): Promise<EnqueueResult> {
    const payload = jsonbParam(JSON.stringify(job.json));
    const mine = sql`j.type = ${handler.type}::text and j.dedupe_key = ${dedupeKey}::text`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = rowsOf<{ id: string; created: boolean }>(
        await target.execute(sql`
          with input as materialized (select ${now()} as now),
          replaced as (
            update ${table} as j set payload = ${payload}, run_at = ${runAt},
              priority = ${job.priority}::int, max_attempts = ${job.maxAttempts}::int,
              status = 'pending', locked_by = null, locked_until = null, updated_at = input.now
            from input
            where ${mine}
              and (j.status = 'pending' or (j.status = 'running' and j.locked_until <= input.now))
            returning j.id::text as id
          ),
          inserted as (
            insert into ${table} as j (type, payload, priority, max_attempts, run_at, dedupe_key, created_at, updated_at)
            select ${handler.type}::text, ${payload}, ${job.priority}::int, ${job.maxAttempts}::int,
              ${runAt}, ${dedupeKey}::text, input.now, input.now
            from input
            where not exists (select 1 from replaced)
            on conflict (type, dedupe_key) where dedupe_key is not null and status in ('pending', 'running') do nothing
            returning j.id::text as id
          )
          select id, false as created from replaced
          union all
          select id, true from inserted`),
      );
      if (row) return { id: row.id, created: row.created === true };
      // A live running job holds the key. It keeps running without it, and the loop enqueues
      // this one. If the job finished or was replaced meanwhile, this changes nothing.
      await target.execute(sql`
        update ${table} as j set dedupe_key = null, updated_at = ${now()}
        where ${mine} and j.status = 'running'`);
    }
    // Other callers kept taking the key between the two statements.
    throw new Error("enqueue with replace kept colliding with other enqueues of the same key");
  }

  /**
   * Enqueues jobs of one type in one statement. Every job is checked first, so a bad one
   * enqueues nothing. Ids are generated here, so each result can be matched to its job whatever
   * order Postgres inserts them in. Of the jobs that share a `dedupeKey`, only the first is
   * inserted, as if they'd been enqueued one after another.
   */
  async function enqueueMany(
    handler: Handler,
    items: readonly EnqueueManyItem<unknown>[],
    manyOptions: EnqueueManyOptions = {},
  ): Promise<EnqueueResult[]> {
    if (!Array.isArray(items)) {
      throw new GroundworkError(
        "invalid_argument",
        "enqueueMany needs a list of jobs, such as [{ payload }, { payload, dedupeKey }].",
      );
    }
    if (items.length > MAX_ENQUEUE_MANY) {
      throw new GroundworkError(
        "invalid_argument",
        `enqueueMany takes at most ${MAX_ENQUEUE_MANY} jobs at a time; split larger batches.`,
      );
    }
    if (typeof manyOptions !== "object" || manyOptions === null) {
      throw new GroundworkError("invalid_argument", "enqueueMany's options must be an object.");
    }
    if (items.length === 0) return [];

    const prepared = await Promise.all(
      items.map(async (item, index) => {
        try {
          // Without this, a bare payload would be read as options and enqueue no payload at all.
          if (typeof item !== "object" || item === null || !("payload" in item)) {
            throw new GroundworkError(
              "invalid_argument",
              "each job needs a payload: { payload, dedupeKey?, delay?, … }.",
            );
          }
          if ("replace" in item && item.replace !== undefined) {
            throw new GroundworkError(
              "invalid_argument",
              "enqueueMany doesn't take replace; use enqueue for each job you want to replace.",
            );
          }
          return await prepare(handler, item.payload, item);
        } catch (error) {
          if (!isGroundworkError(error)) throw error;
          throw new GroundworkError(error.code, `jobs[${index}]: ${error.message}`, {
            cause: error,
          });
        }
      }),
    );
    const records = prepared.map((job, i) => ({
      i,
      id: randomUUID(),
      // As text, so a null payload is stored as JSON null, as enqueue() stores it.
      payload: JSON.stringify(job.json),
      priority: job.priority,
      max_attempts: job.maxAttempts,
      run_at: job.runAt?.toISOString() ?? null,
      delay_ms: job.delayMs,
      dedupe_key: job.dedupeKey,
    }));

    const target = manyOptions.tx ?? db;
    const rows = rowsOf<{ kind: "inserted" | "existing"; id: string; dedupe_key: string | null }>(
      await target.execute(sql`
        with input as materialized (select ${now()} as now),
        items as (
          select * from jsonb_to_recordset(${jsonbParam(JSON.stringify(records))}) as t(
            i int, id uuid, payload text, priority int, max_attempts int, run_at timestamptz,
            delay_ms float8, dedupe_key text)
        ),
        firsts as (
          select * from items where dedupe_key is null
          union all
          (select distinct on (dedupe_key) * from items where dedupe_key is not null
            order by dedupe_key, i)
        ),
        inserted as (
          insert into ${table} as j (id, type, payload, priority, max_attempts, run_at, dedupe_key, created_at, updated_at)
          select f.id, ${handler.type}::text, f.payload::jsonb, f.priority, f.max_attempts,
            coalesce(f.run_at, input.now + coalesce(f.delay_ms, 0) * interval '1 millisecond'),
            f.dedupe_key, input.now, input.now
          from firsts as f, input
          order by f.i
          on conflict (type, dedupe_key) where dedupe_key is not null and status in ('pending', 'running') do nothing
          returning j.id::text as id, j.dedupe_key
        )
        select 'inserted' as kind, id, dedupe_key from inserted
        union all
        select 'existing', j.id::text, j.dedupe_key from ${table} as j
        where j.type = ${handler.type}::text and j.status in ('pending', 'running')
          and j.dedupe_key in (select dedupe_key from items where dedupe_key is not null)`),
    );

    const inserted = new Set<string>();
    const byKey = new Map<string, string>();
    for (const row of rows) {
      if (row.kind === "inserted") inserted.add(row.id);
      if (row.dedupe_key !== null) byKey.set(row.dedupe_key, row.id);
    }
    // A duplicate that committed after this statement's snapshot was taken: look those up again.
    const unknownKeys = [
      ...new Set(
        records.flatMap((record) =>
          !inserted.has(record.id) && record.dedupe_key !== null && !byKey.has(record.dedupe_key)
            ? [record.dedupe_key]
            : [],
        ),
      ),
    ];
    if (unknownKeys.length > 0) {
      const found = rowsOf<{ id: string; dedupe_key: string }>(
        await target.execute(sql`
          select id::text as id, dedupe_key from ${table}
          where type = ${handler.type}::text and status in ('pending', 'running')
            and dedupe_key in (${sql.join(
              unknownKeys.map((key) => sql`${key}::text`),
              sql`, `,
            )})`),
      );
      for (const row of found) byKey.set(row.dedupe_key, row.id);
    }

    return records.map((record) => {
      if (inserted.has(record.id)) return { id: record.id, created: true };
      const existing = record.dedupe_key === null ? undefined : byKey.get(record.dedupe_key);
      if (existing === undefined) {
        throw new Error("enqueueMany found neither a new job nor the duplicate it collided with");
      }
      return { id: existing, created: false };
    });
  }

  // ── Schedules ──────────────────────────────────────────────────────────────

  const scheduleValues = () =>
    sql.join(
      [...schedules.values()].map(
        (s) =>
          sql`(${s.name}::text, ${s.every}::text, ${s.everyMs}::float8, ${s.maxAttempts}::int)`,
      ),
      sql`, `,
    );

  async function syncSchedules(): Promise<void> {
    if (schedulesSynced || schedules.size === 0) return;
    // New schedules are due at once; existing ones keep their next run.
    await db.execute(sql`
      insert into ${schedulesTable} (name, every, next_run_at, created_at, updated_at)
      select v.name, v.every, ${now()}, ${now()}, ${now()}
      from (values ${scheduleValues()}) as v(name, every, every_ms, max_attempts)
      on conflict (name) do update set every = excluded.every, updated_at = excluded.updated_at
      where ${schedulesTable}.every is distinct from excluded.every`);
    schedulesSynced = true;
  }

  /**
   * One statement per tick: move each due schedule's next run forward (a conditional update, so
   * of several instances only one wins) and enqueue its job. The job's dedupe key skips a tick
   * while the previous one is still pending or running.
   *
   * Ticks keep to a grid: the next run is the previous slot plus `every`, not now plus `every`,
   * so a poll's lag doesn't add up. A tick is due up to `min(every / 10, 5s)` early, so a cron
   * that calls a moment before the slot still runs it, instead of every other time. When whole
   * slots were missed (nothing ran), the grid restarts from now, rather than catching up.
   */
  async function tickSchedules(): Promise<number> {
    if (schedules.size === 0) return 0;
    await syncSchedules();
    const [row] = rowsOf<{ enqueued: unknown }>(
      await db.execute(sql`
        with input as materialized (select ${now()} as now),
        v (name, every, every_ms, max_attempts) as (values ${scheduleValues()}),
        due as (
          update ${schedulesTable} as s
          set next_run_at = case
                when s.next_run_at + v.every_ms * interval '1 millisecond' > input.now
                  then s.next_run_at + v.every_ms * interval '1 millisecond'
                else input.now + v.every_ms * interval '1 millisecond'
              end,
            last_run_at = input.now, updated_at = input.now
          from input, v
          where s.name = v.name
            and s.next_run_at <= input.now + least(v.every_ms / 10, ${SCHEDULE_EARLY_MAX_MS}::float8) * interval '1 millisecond'
          returning s.name, v.max_attempts
        ),
        enqueued as (
          insert into ${table} (type, payload, max_attempts, run_at, dedupe_key, created_at, updated_at)
          select ${SCHEDULE_PREFIX} || due.name,
            jsonb_build_object('scheduledAt', to_char(input.now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            due.max_attempts, input.now, 'tick', input.now, input.now
          from due, input
          on conflict (type, dedupe_key) where dedupe_key is not null and status in ('pending', 'running') do nothing
          returning 1
        )
        select (select count(*) from enqueued)::int as enqueued`),
    );
    return row ? toNumber(row.enqueued) : 0;
  }

  // ── Running jobs ───────────────────────────────────────────────────────────

  async function claim(limit: number): Promise<StoredJob[]> {
    const types = [...handlers.keys()];
    if (types.length === 0 || limit < 1) return [];
    const rows = rowsOf<{ record: string }>(
      await db.execute(sql`
        with input as materialized (select ${now()} as now),
        candidates as (
          select c.id from ${table} c, input
          where c.status in ('pending', 'running') and c.run_at <= input.now
            and c.type in (${sql.join(
              types.map((type) => sql`${type}::text`),
              sql`, `,
            )})
          order by c.priority desc nulls last, c.run_at, c.id
          limit ${limit}
          for update of c skip locked
        )
        update ${table} as j
        set status = 'running', attempts = j.attempts + 1, locked_by = ${workerId}::text,
          locked_until = input.now + ${lease}, run_at = input.now + ${lease},
          started_at = coalesce(j.started_at, input.now), updated_at = input.now
        from candidates, input
        where j.id = candidates.id
        returning ${RECORD} as record`),
    );
    return rows.map((row) => JSON.parse(row.record) as StoredJob);
  }

  /** Only the worker holding the latest attempt may change a running job. */
  const owned = (job: StoredJob) =>
    sql`j.id = ${job.id}::uuid and j.status = 'running' and j.locked_by = ${workerId}::text and j.attempts = ${job.attempts}::int`;

  async function extendLease(job: StoredJob): Promise<boolean> {
    const rows = rowsOf(
      await db.execute(sql`
        update ${table} as j set locked_until = ${now()} + ${lease}, run_at = ${now()} + ${lease}, updated_at = ${now()}
        where ${owned(job)} returning 1`),
    );
    return rows.length > 0;
  }

  async function complete(job: StoredJob, handler: Handler, result: unknown): Promise<boolean> {
    const scheduleUpdate = handler.schedule
      ? sql`, touched as (
          update ${schedulesTable} set last_success_at = ${now()}, last_error = null, updated_at = ${now()}
          where name = ${handler.schedule}::text and exists (select 1 from done))`
      : sql``;
    const [row] = rowsOf<{ done: unknown }>(
      await db.execute(sql`
        with done as (
          update ${table} as j set status = 'completed', completed_at = ${now()}, result = ${jsonbParam(JSON.stringify(toJsonValue(result)))},
            last_error = null, locked_by = null, locked_until = null, updated_at = ${now()}
          where ${owned(job)} returning 1
        )${scheduleUpdate}
        select count(*)::int as done from done`),
    );
    return row !== undefined && toNumber(row.done) === 1;
  }

  async function fail(
    job: StoredJob,
    handler: Handler,
    error: unknown,
    permanent: boolean,
  ): Promise<"retried" | "failed" | "lost"> {
    const { name, message } = errorText(error);
    const lastError = `${name}: ${message}`.slice(0, MAX_ERROR_LENGTH);
    const exhausted = permanent || job.attempts >= job.max_attempts;
    const delayMs = exhausted
      ? 0
      : handler.backoffDelaysMs
        ? ladderDelayMs(job.attempts, handler.backoffDelaysMs)
        : backoffDelayMs(job.attempts, handler.backoffBaseMs, handler.backoffMaxMs, random);
    const scheduleUpdate = handler.schedule
      ? sql`, touched as (
          update ${schedulesTable} set last_failure_at = ${now()}, last_error = ${lastError}::text, updated_at = ${now()}
          where name = ${handler.schedule}::text and exists (select 1 from done))`
      : sql``;
    const [row] = rowsOf<{ done: unknown }>(
      await db.execute(sql`
        with done as (
          update ${table} as j set
            status = ${exhausted ? "failed" : "pending"}::text,
            run_at = ${exhausted ? sql`j.run_at` : sql`${now()} + ${delayMs}::float8 * interval '1 millisecond'`},
            completed_at = ${exhausted ? now() : sql`null`},
            last_error = ${lastError}::text, locked_by = null, locked_until = null, updated_at = ${now()}
          where ${owned(job)} returning 1
        )${scheduleUpdate}
        select count(*)::int as done from done`),
    );
    if (!row || toNumber(row.done) !== 1) return "lost";
    const context = { type: job.type, id: job.id, attempt: job.attempts, error: { name, message } };
    if (exhausted) {
      logger.error(`Job "${job.type}" failed for good after ${job.attempts} attempt(s).`, context);
    } else {
      logger.warn(`Job "${job.type}" failed; retrying in ${Math.ceil(delayMs / 1000)}s.`, context);
    }
    return exhausted ? "failed" : "retried";
  }

  interface Counters {
    claimed: number;
    completed: number;
    retried: number;
    failed: number;
    scheduled: number;
  }

  async function execute(job: StoredJob, counters: Counters): Promise<void> {
    const handler = handlers.get(job.type);
    if (!handler) return; // claim only selects known types
    const controller = new AbortController();
    const context: JobContext | ScheduleContext = {
      id: job.id,
      type: job.type,
      attempt: job.attempts,
      maxAttempts: job.max_attempts,
      signal: controller.signal,
      createdAt: new Date(job.created_at),
      ...(handler.schedule
        ? {
            scheduledAt: scheduledAtOf(job),
          }
        : {}),
    };
    const record = (outcome: "retried" | "failed" | "lost") => {
      if (outcome === "lost") {
        logger.warn(
          `Job "${job.type}" finished after this worker lost its lease; another worker owns it now.`,
          {
            type: job.type,
            id: job.id,
            attempt: job.attempts,
          },
        );
      } else counters[outcome]++;
    };
    const runExhausted = async (payload: unknown, error: unknown) => {
      if (!handler.onExhausted) return;
      try {
        await handler.onExhausted(payload, { ...errorText(error), attempt: job.attempts }, context);
      } catch (hookError) {
        logger.error(`onExhausted of job "${job.type}" threw.`, {
          id: job.id,
          error: errorText(hookError),
        });
      }
    };

    // Its worker stopped during the last attempt (the lease ran out): that attempt counts.
    if (job.attempts > job.max_attempts) {
      const error = new Error("The worker running the last attempt stopped before finishing.");
      record(await fail(job, handler, error, true));
      await runExhausted(job.payload, error);
      return;
    }

    let payload = job.payload;
    if (handler.schema) {
      const checked = await validateWith(handler.schema, job.payload);
      if (!checked.ok) {
        // A payload that doesn't validate never will: fail now instead of retrying.
        const error = new GroundworkError(
          "invalid_argument",
          `Invalid payload: ${checked.message}`,
        );
        record(await fail(job, handler, error, true));
        await runExhausted(job.payload, error);
        return;
      }
      payload = checked.value;
    }

    const timer =
      handler.timeoutMs === null
        ? undefined
        : setTimeout(() => {
            const error = new Error(`Timed out after ${handler.timeoutMs}ms.`);
            error.name = "TimeoutError";
            controller.abort(error);
          }, handler.timeoutMs);
    const heartbeat = setInterval(() => {
      extendLease(job)
        .then((kept) => {
          if (!kept && !controller.signal.aborted) {
            const error = new Error("This worker lost the job's lease.");
            error.name = "LeaseLostError";
            controller.abort(error);
          }
        })
        .catch((error: unknown) => {
          once.once("warn", "heartbeat", "Could not renew a job lease; retrying.", {
            error: errorText(error),
          });
        });
    }, renewEveryMs(leaseMs));
    try {
      const running = Promise.resolve().then(() => handler.run(payload, context));
      // A handler that ignores the signal keeps running, but its outcome no longer counts.
      running.catch(() => {});
      const aborted = new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      });
      aborted.catch(() => {});
      const result = await Promise.race([running, aborted]);
      if (await complete(job, handler, result)) counters.completed++;
      else record("lost");
    } catch (error) {
      const outcome = await fail(job, handler, error, false);
      record(outcome);
      if (outcome === "failed") await runExhausted(payload, error);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
    }
  }

  async function loop(settings: {
    concurrency: number;
    deadline: number | null;
    signal: AbortSignal | undefined;
    pollMs: number;
    mode: "once" | "work";
  }): Promise<RunSummary> {
    const started = performance.now();
    const counters: Counters = { claimed: 0, completed: 0, retried: 0, failed: 0, scheduled: 0 };
    const inFlight = new Set<Promise<void>>();
    const stopping = () =>
      settings.signal?.aborted === true ||
      (settings.deadline !== null && performance.now() >= settings.deadline);
    let lastTick = Number.NEGATIVE_INFINITY;

    const wait = (msToWait: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(done, msToWait);
        settings.signal?.addEventListener("abort", done, { once: true });
        for (const promise of inFlight) promise.then(done, done);
        function done() {
          clearTimeout(timer);
          // Without this, every idle poll of a long-running worker would leave a listener behind.
          settings.signal?.removeEventListener("abort", done);
          resolve();
        }
      });

    try {
      while (!stopping()) {
        try {
          if (performance.now() - lastTick >= settings.pollMs) {
            lastTick = performance.now();
            counters.scheduled += await tickSchedules();
          }
          const free = settings.concurrency - inFlight.size;
          const claimed = free > 0 ? await claim(free) : [];
          if (claimed.length > 0) once.reset("claim");
          counters.claimed += claimed.length;
          for (const job of claimed) {
            const promise: Promise<void> = execute(job, counters).finally(() =>
              inFlight.delete(promise),
            );
            inFlight.add(promise);
          }
          if (inFlight.size >= settings.concurrency) {
            await Promise.race(inFlight);
          } else if (claimed.length < free) {
            // Nothing more is due right now.
            if (settings.mode === "once") {
              if (inFlight.size === 0) break;
              await Promise.race(inFlight); // a finishing job may have enqueued another
            } else {
              await wait(settings.pollMs);
            }
          }
        } catch (error) {
          if (settings.mode === "once") throw error;
          once.once(
            "error",
            "claim",
            "The job worker could not reach the database; it keeps retrying.",
            {
              error: errorText(error),
            },
          );
          await wait(settings.pollMs);
        }
      }
    } finally {
      await Promise.allSettled([...inFlight]);
    }
    return { ...counters, durationMs: Math.round(performance.now() - started) };
  }

  const validConcurrency = (value: unknown) =>
    value === undefined ? 4 : positiveInt(value, "concurrency", "invalid_argument");
  const validId = (id: unknown): id is string =>
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  const jobs: Jobs = {
    define(type: string, definition: object) {
      validateName(type, "job type");
      if (type.startsWith(SCHEDULE_PREFIX)) {
        throw new GroundworkError(
          "invalid_config",
          `Job types can't start with "${SCHEDULE_PREFIX}"; that prefix is for schedules.`,
        );
      }
      if (typeof definition !== "object" || definition === null) {
        throw new GroundworkError(
          "invalid_config",
          `Job type "${type}" needs a definition object.`,
        );
      }
      const handler = addHandler(type, definition as Record<string, unknown>, {
        maxAttempts: 5,
        base: "30s",
        max: "1h",
        timeout: "5m",
      });
      return {
        type,
        enqueue: (payload: unknown, enqueueOptions?: EnqueueOptions) =>
          enqueue(handler, payload, enqueueOptions),
        enqueueMany: (
          items: readonly EnqueueManyItem<unknown>[],
          manyOptions?: EnqueueManyOptions,
        ) => enqueueMany(handler, items, manyOptions),
      } as JobHandle<string, unknown>;
    },

    schedule(name, scheduleOptions: ScheduleOptions, run) {
      validateName(name, "schedule name");
      if (schedules.has(name)) {
        throw new GroundworkError("invalid_config", `Schedule "${name}" is already defined.`);
      }
      if (
        typeof scheduleOptions !== "object" ||
        scheduleOptions === null ||
        !isDuration(scheduleOptions.every)
      ) {
        throw new GroundworkError(
          "invalid_config",
          `Schedule "${name}" needs { every }, such as "1h".`,
        );
      }
      const everyMs = parseDuration(scheduleOptions.every, {
        label: `every of schedule "${name}"`,
        minMs: 1_000,
      });
      const handler = addHandler(
        `${SCHEDULE_PREFIX}${name}`,
        {
          ...scheduleOptions,
          run: (_payload: unknown, context: JobContext) => run(context as ScheduleContext),
        },
        { maxAttempts: 3, base: "5s", max: "1m", timeout: "5m" },
        name,
      );
      schedules.set(name, {
        name,
        every: scheduleOptions.every,
        everyMs,
        maxAttempts: handler.maxAttempts,
      });
      schedulesSynced = false;
    },

    async trigger(name) {
      if (!schedules.has(name)) return false;
      await syncSchedules();
      const rows = rowsOf(
        await db.execute(
          sql`update ${schedulesTable} set next_run_at = ${now()}, updated_at = ${now()} where name = ${name}::text returning 1`,
        ),
      );
      return rows.length > 0;
    },

    runOnce(runOptions: RunOnceOptions = {}) {
      const budgetMs = runOptions.budgetMs ?? 10_000;
      if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs) || budgetMs <= 0) {
        throw new GroundworkError(
          "invalid_argument",
          "budgetMs must be a positive number of milliseconds.",
        );
      }
      return loop({
        concurrency: validConcurrency(runOptions.concurrency),
        deadline: performance.now() + budgetMs,
        signal: undefined,
        pollMs: 0,
        mode: "once",
      });
    },

    work(workOptions: WorkOptions = {}) {
      return loop({
        concurrency: validConcurrency(workOptions.concurrency),
        deadline: null,
        signal: workOptions.signal,
        pollMs: parseDuration(workOptions.pollInterval ?? "1s", {
          label: "pollInterval",
          maxMs: MAX_TIMER_MS,
          minMs: 10,
        }),
        mode: "work",
      });
    },

    async get(id) {
      if (!validId(id)) return null;
      const [row] = rowsOf<{ record: string }>(
        await db.execute(sql`select ${RECORD} as record from ${table} j where j.id = ${id}::uuid`),
      );
      return row ? toRecord(JSON.parse(row.record) as StoredJob) : null;
    },

    async list(filter: JobListFilter = {}) {
      const limit = filter.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST) {
        throw new GroundworkError(
          "invalid_argument",
          `limit must be an integer from 1 to ${MAX_LIST}.`,
        );
      }
      const conditions: SQL[] = [];
      const listOf = (value: string | readonly string[]) =>
        (Array.isArray(value) ? value : [value]) as string[];
      const inList = (column: string, values: string[]) =>
        values.length === 0
          ? sql`false`
          : sql`${sql.raw(column)} in (${sql.join(
              values.map((v) => sql`${v}::text`),
              sql`, `,
            )})`;
      if (filter.type !== undefined) conditions.push(inList("j.type", listOf(filter.type)));
      if (filter.schedule !== undefined) {
        const names = listOf(filter.schedule).map((name) => `${SCHEDULE_PREFIX}${name}`);
        conditions.push(inList("j.type", names));
      }
      if (filter.status !== undefined) conditions.push(inList("j.status", listOf(filter.status)));
      if (filter.since !== undefined) {
        if (!(filter.since instanceof Date) || Number.isNaN(filter.since.getTime())) {
          throw new GroundworkError("invalid_argument", "since must be a valid Date.");
        }
        conditions.push(sql`j.created_at >= ${filter.since.toISOString()}::timestamptz`);
      }
      const where =
        conditions.length === 0 ? sql`` : sql`where ${sql.join(conditions, sql` and `)}`;
      const rows = rowsOf<{ record: string }>(
        await db.execute(
          sql`select ${RECORD} as record from ${table} j ${where} order by j.created_at desc, j.id desc limit ${limit}`,
        ),
      );
      return rows.map((row) => toRecord(JSON.parse(row.record) as StoredJob));
    },

    async retry(id) {
      if (!validId(id)) return false;
      try {
        const rows = rowsOf(
          await db.execute(sql`
            update ${table} set status = 'pending', attempts = 0, run_at = ${now()}, completed_at = null,
              locked_by = null, locked_until = null, updated_at = ${now()}
            where id = ${id}::uuid and status in ('failed', 'cancelled') returning 1`),
        );
        return rows.length > 0;
      } catch (error) {
        // Another job with the same dedupe key is already pending or running.
        const code =
          (error as { code?: unknown; cause?: { code?: unknown } })?.code ??
          (error as { cause?: { code?: unknown } })?.cause?.code;
        if (code === "23505") return false;
        throw error;
      }
    },

    async cancel(id) {
      if (!validId(id)) return false;
      const rows = rowsOf(
        await db.execute(sql`
          update ${table} set status = 'cancelled', completed_at = ${now()}, updated_at = ${now()}
          where id = ${id}::uuid and status = 'pending' returning 1`),
      );
      return rows.length > 0;
    },

    async prune(pruneOptions) {
      if (typeof pruneOptions !== "object" || pruneOptions === null) {
        throw new GroundworkError(
          "invalid_argument",
          'prune needs { completedOlderThan }, such as "7d".',
        );
      }
      const completedMs = parseDuration(pruneOptions.completedOlderThan, {
        label: "completedOlderThan",
        minMs: 1,
      });
      const failedMs =
        pruneOptions.failedOlderThan === undefined
          ? completedMs
          : parseDuration(pruneOptions.failedOlderThan, { label: "failedOlderThan", minMs: 1 });
      let total = 0;
      for (;;) {
        const [row] = rowsOf<{ deleted: unknown }>(
          await db.execute(sql`
            with input as materialized (select ${now()} as now),
            doomed as (
              select j.id from ${table} j, input
              where (j.status in ('completed', 'cancelled') and j.completed_at < input.now - ${completedMs}::float8 * interval '1 millisecond')
                 or (j.status = 'failed' and j.completed_at < input.now - ${failedMs}::float8 * interval '1 millisecond')
              limit ${PRUNE_BATCH}
            ),
            deleted as (delete from ${table} where id in (select id from doomed) returning 1)
            select count(*)::int as deleted from deleted`),
        );
        const deleted = row ? toNumber(row.deleted) : 0;
        total += deleted;
        if (deleted < PRUNE_BATCH) return total;
      }
    },

    async health(): Promise<JobsHealth> {
      await syncSchedules();
      const typeRows = rowsOf<{
        type: string;
        pending: unknown;
        running: unknown;
        failed_24h: unknown;
        oldest_pending_age_ms: unknown;
        last_success: unknown;
      }>(
        await db.execute(sql`
          with input as materialized (select ${now()} as now)
          select j.type,
            count(*) filter (where j.status = 'pending')::int as pending,
            count(*) filter (where j.status = 'running')::int as running,
            count(*) filter (where j.status = 'failed' and j.completed_at > input.now - interval '24 hours')::int as failed_24h,
            ${sql.raw(ms("input.now"))} - ${sql.raw(ms("min(j.run_at) filter (where j.status = 'pending' and j.run_at <= input.now)"))} as oldest_pending_age_ms,
            ${sql.raw(ms("max(j.completed_at) filter (where j.status = 'completed')"))} as last_success
          from ${table} j, input
          group by j.type, input.now`),
      );
      const byType = new Map(typeRows.map((row) => [row.type, row]));
      const known = [...new Set([...handlers.keys(), ...byType.keys()])].sort();
      const types = known.map((type) => {
        const row = byType.get(type);
        const number = (value: unknown) =>
          value === null || value === undefined ? 0 : toNumber(value);
        return {
          type,
          pending: number(row?.pending),
          running: number(row?.running),
          failedLast24h: number(row?.failed_24h),
          oldestPendingAgeMs:
            row?.oldest_pending_age_ms === null || row?.oldest_pending_age_ms === undefined
              ? null
              : Math.max(0, Math.round(toNumber(row.oldest_pending_age_ms))),
          lastSuccessAt:
            row?.last_success === null || row?.last_success === undefined
              ? null
              : new Date(toNumber(row.last_success)),
        };
      });

      const names = [...schedules.keys()];
      const scheduleRows =
        names.length === 0
          ? []
          : rowsOf<{
              name: string;
              every: string;
              next_run_at: unknown;
              last_run_at: unknown;
              last_success_at: unknown;
              last_failure_at: unknown;
              last_error: string | null;
              now: unknown;
            }>(
              await db.execute(sql`
                with input as materialized (select ${now()} as now)
                select s.name, s.every, ${sql.raw(ms("s.next_run_at"))} as next_run_at, ${sql.raw(ms("s.last_run_at"))} as last_run_at,
                  ${sql.raw(ms("s.last_success_at"))} as last_success_at, ${sql.raw(ms("s.last_failure_at"))} as last_failure_at,
                  s.last_error, ${sql.raw(ms("input.now"))} as now
                from ${schedulesTable} s, input
                where s.name in (${sql.join(
                  names.map((name) => sql`${name}::text`),
                  sql`, `,
                )})
                order by s.name`),
            );
      const optionalDate = (value: unknown) =>
        value === null || value === undefined ? null : new Date(toNumber(value));
      const schedulesHealth = scheduleRows.map((row) => {
        const entry = schedules.get(row.name);
        const lastSuccess = optionalDate(row.last_success_at);
        return {
          name: row.name,
          every: (entry?.every ?? row.every) as Duration,
          nextRunAt: new Date(toNumber(row.next_run_at)),
          lastRunAt: optionalDate(row.last_run_at),
          lastSuccessAt: lastSuccess,
          lastFailureAt: optionalDate(row.last_failure_at),
          lastError: row.last_error,
          healthy:
            lastSuccess !== null &&
            entry !== undefined &&
            toNumber(row.now) - lastSuccess.getTime() < entry.everyMs * 3,
        };
      });
      return { types, schedules: schedulesHealth };
    },
  };
  return jobs;
}
