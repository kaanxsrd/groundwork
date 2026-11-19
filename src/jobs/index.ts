/**
 * `groundwork/jobs`: background jobs and schedules on Postgres, enqueued inside your
 * transactions, with leases, retries with jittered backoff, timeouts and health checks.
 *
 * ```ts
 * import { createJobs } from "groundwork/jobs";
 *
 * const jobs = createJobs({ db, table: tables.jobs, schedulesTable: tables.jobSchedules });
 *
 * export const sendReceipt = jobs.define("email.receipt", {
 *   schema: z.object({ orderId: z.string() }),
 *   maxAttempts: 5,
 *   async run({ orderId }, { signal }) { await mailer.sendReceipt(orderId, { signal }); },
 * });
 *
 * await db.transaction(async (tx) => {
 *   await tx.insert(orders).values(order);
 *   await sendReceipt.enqueue({ orderId: order.id }, { tx, dedupeKey: `receipt:${order.id}` });
 * });
 *
 * jobs.schedule("reports.nightly", { every: "1d" }, () => buildReports());
 * await jobs.work({ concurrency: 4, signal });
 * ```
 *
 * @module
 */

export type { StandardSchemaV1 } from "../internal/standard-schema.ts";
export { backoffDelayMs } from "./backoff.ts";
export { createJobs, type JobsOptions } from "./jobs.ts";
export type {
  BackoffOptions,
  EnqueueOptions,
  EnqueueResult,
  JobContext,
  JobDefinition,
  JobDefinitionWithSchema,
  JobFailure,
  JobHandle,
  JobListFilter,
  JobRecord,
  JobStatus,
  Jobs,
  JobsHealth,
  JobTypeHealth,
  RunOnceOptions,
  RunSummary,
  ScheduleContext,
  ScheduleHealth,
  ScheduleOptions,
  WorkOptions,
} from "./types.ts";
