import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { TableFactory } from "./factory.ts";

/** Every status a job can be in. */
export const JOB_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;

/**
 * One row per job.
 *
 * - A job is claimable when `status` is pending or running and `run_at` has passed. While a job
 *   runs, `run_at` holds its lease expiry (as does `locked_until`), so a worker that dies leaves
 *   a job that becomes claimable again by itself, through the same index.
 * - `attempts` counts the tries of the current payload, up to `max_attempts`. A replace or a
 *   retry starts it again.
 * - `claims` counts every claim, and is the fencing token: a worker can only finish a job if its
 *   claim is still the latest. It never goes down, so a worker that stalled can't match again
 *   after a replace or retry resets `attempts`.
 * - `dedupe_key` is unique per type while a job is pending or running.
 *
 * Status is `text` with a check constraint rather than a Postgres enum, because an enum would
 * have to be exported separately for drizzle-kit to create it.
 */
export function buildJobsTable<TSchema extends string | undefined>(factory: TableFactory<TSchema>) {
  // Every name is built up front: Drizzle calls the extraConfig callback lazily.
  const tableName = factory.name("jobs");
  const claimIndex = factory.name("jobs_claim_idx");
  const dedupeIndex = factory.name("jobs_dedupe_idx");
  const finishedIndex = factory.name("jobs_finished_idx");
  const statusCheck = factory.name("jobs_status_check");
  return factory.table(
    tableName,
    {
      id: uuid("id").primaryKey().defaultRandom(),
      type: text("type").notNull(),
      payload: jsonb("payload").$type<unknown>().notNull().default(sql`'{}'::jsonb`),
      status: text("status").$type<(typeof JOB_STATUSES)[number]>().notNull().default("pending"),
      priority: integer("priority").notNull().default(0),
      attempts: integer("attempts").notNull().default(0),
      maxAttempts: integer("max_attempts").notNull().default(5),
      claims: integer("claims").notNull().default(0),
      runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
      lockedUntil: timestamp("locked_until", { withTimezone: true }),
      lockedBy: text("locked_by"),
      dedupeKey: text("dedupe_key"),
      lastError: text("last_error"),
      result: jsonb("result").$type<unknown>(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      index(claimIndex)
        .on(t.priority.desc(), t.runAt, t.id)
        .where(sql`status in ('pending', 'running')`),
      uniqueIndex(dedupeIndex)
        .on(t.type, t.dedupeKey)
        .where(sql`dedupe_key is not null and status in ('pending', 'running')`),
      index(finishedIndex)
        .on(t.completedAt)
        .where(sql`status in ('completed', 'failed', 'cancelled')`),
      check(statusCheck, sql`status in ('pending', 'running', 'completed', 'failed', 'cancelled')`),
    ],
  );
}

/**
 * One row per schedule. A tick is claimed by moving `next_run_at` forward with a conditional
 * update, so only one instance ever runs it.
 */
export function buildJobSchedulesTable<TSchema extends string | undefined>(
  factory: TableFactory<TSchema>,
) {
  return factory.table(factory.name("job_schedules"), {
    name: text("name").primaryKey(),
    every: text("every").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  });
}

export type JobsTable<TSchema extends string | undefined = string | undefined> = ReturnType<
  typeof buildJobsTable<TSchema>
>;
export type JobSchedulesTable<TSchema extends string | undefined = string | undefined> = ReturnType<
  typeof buildJobSchedulesTable<TSchema>
>;

export const JOB_COLUMNS = [
  "id",
  "type",
  "payload",
  "status",
  "priority",
  "attempts",
  "max_attempts",
  "claims",
  "run_at",
  "locked_until",
  "locked_by",
  "dedupe_key",
  "last_error",
  "result",
  "created_at",
  "started_at",
  "completed_at",
  "updated_at",
] as const;

export const JOB_SCHEDULE_COLUMNS = [
  "name",
  "every",
  "next_run_at",
  "last_run_at",
  "last_success_at",
  "last_failure_at",
  "last_error",
  "created_at",
  "updated_at",
] as const;
