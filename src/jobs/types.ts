import type { GroundworkDatabase } from "../internal/db.ts";
import type { Duration } from "../internal/duration.ts";
import type { StandardSchemaV1 } from "../internal/standard-schema.ts";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** What a handler gets besides its payload. */
export interface JobContext {
  readonly id: string;
  readonly type: string;
  /** 1 on the first try. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /**
   * Aborted when the job's `timeout` passes, or if this worker loses the job's lease. Pass it to
   * `fetch` and database calls so a stuck job stops instead of running on in the background.
   */
  readonly signal: AbortSignal;
  readonly createdAt: Date;
}

export interface ScheduleContext extends JobContext {
  /** When this tick was claimed. */
  readonly scheduledAt: Date;
}

/**
 * How long a failed job waits before its next attempt. Either exponential with full jitter (a
 * random wait between 0 and `min(max, base * 2^(attempt - 1))`, the default), or a fixed ladder
 * of `delays`.
 */
export type BackoffOptions =
  | {
      /** Defaults to `"30s"`. */
      readonly base?: Duration | undefined;
      /** Defaults to `"1h"`. */
      readonly max?: Duration | undefined;
      readonly delays?: undefined;
    }
  | {
      /**
       * After the n-th failed attempt, wait `delays[n - 1]`, exactly; once the list runs out, its
       * last delay repeats. `["30s", "2m", "10m", "30m", "1h"]` retries after 30 seconds, then
       * 2 minutes, and so on, then hourly. Up to 100 steps.
       */
      readonly delays: readonly Duration[];
      readonly base?: undefined;
      readonly max?: undefined;
    };

/** Why a job failed for good, passed to `onExhausted`. Never includes the payload. */
export interface JobFailure {
  readonly name: string;
  readonly message: string;
  readonly attempt: number;
}

interface JobOptions {
  /** Tries before the job fails for good. Defaults to 5. */
  readonly maxAttempts?: number | undefined;
  readonly backoff?: BackoffOptions | undefined;
  /** Abort the handler after this long. Defaults to `"5m"`; `false` for none. */
  readonly timeout?: Duration | false | undefined;
  /** Higher runs first. Defaults to 0. */
  readonly priority?: number | undefined;
}

export interface JobDefinitionWithSchema<TSchema extends StandardSchemaV1> extends JobOptions {
  /** Any Standard Schema (zod, valibot, arktype…). Checked on enqueue and again before running. */
  readonly schema: TSchema;
  run(payload: StandardSchemaV1.InferOutput<TSchema>, context: JobContext): unknown;
  /** Called once when the last attempt fails, for example to mark a notification as failed. */
  onExhausted?(
    payload: StandardSchemaV1.InferOutput<TSchema>,
    failure: JobFailure,
    context: JobContext,
  ): unknown;
}

export interface JobDefinition<TPayload> extends JobOptions {
  readonly schema?: undefined;
  /** Annotate `payload` to type `enqueue`: `run(payload: { orderId: string }) {…}`. */
  run(payload: TPayload, context: JobContext): unknown;
  onExhausted?(payload: TPayload, failure: JobFailure, context: JobContext): unknown;
}

export interface EnqueueOptions {
  /** Enqueue inside this transaction: the job only exists if it commits. */
  readonly tx?: GroundworkDatabase | undefined;
  /** Not before this time. */
  readonly runAt?: Date | undefined;
  /** Not before this long from now. */
  readonly delay?: Duration | undefined;
  /** Overrides the type's priority. */
  readonly priority?: number | undefined;
  /** While a job of this type with this key is pending or running, enqueueing it again does nothing. */
  readonly dedupeKey?: string | undefined;
  /**
   * With `dedupeKey`, to debounce: instead of keeping the pending job with this key, give it this
   * call's payload, timing, priority and `maxAttempts`, from attempt 1 again. If that job is
   * already running, it finishes without the key and isn't retried, and this one is enqueued as a
   * new job, so the latest payload always runs. `created` is `false` when a job was replaced.
   */
  readonly replace?: boolean | undefined;
  /** Overrides the type's `maxAttempts`. */
  readonly maxAttempts?: number | undefined;
}

export interface EnqueueResult {
  readonly id: string;
  /** `false` when `dedupeKey` matched a job that is already pending or running; `id` is that job. */
  readonly created: boolean;
}

/** One job for `enqueueMany`: its payload, and `enqueue`'s options except `tx` and `replace`. */
export interface EnqueueManyItem<TInput> extends Omit<EnqueueOptions, "tx" | "replace"> {
  readonly payload: TInput;
}

export interface EnqueueManyOptions {
  /** Enqueue inside this transaction: the jobs only exist if it commits. */
  readonly tx?: GroundworkDatabase | undefined;
}

export interface JobHandle<TType extends string, TInput> {
  readonly type: TType;
  enqueue(payload: TInput, options?: EnqueueOptions): Promise<EnqueueResult>;
  /**
   * Enqueues up to 1,000 jobs of this type in one statement, each with its own options. Every
   * job is checked first, so one bad job enqueues none. Results are in the same order as the
   * jobs. A `dedupeKey` works as it does for `enqueue`, also between jobs in the same call: the
   * first one is created, and the others return its id.
   */
  enqueueMany(
    jobs: readonly EnqueueManyItem<TInput>[],
    options?: EnqueueManyOptions,
  ): Promise<EnqueueResult[]>;
}

export interface ScheduleOptions {
  readonly every: Duration;
  /** Tries per tick. Defaults to 3. */
  readonly maxAttempts?: number | undefined;
  /** Defaults to `{ base: "5s", max: "1m" }`. */
  readonly backoff?: BackoffOptions | undefined;
  /** Defaults to `"5m"`. */
  readonly timeout?: Duration | false | undefined;
}

export interface RunSummary {
  readonly claimed: number;
  readonly completed: number;
  /** Failed and scheduled to try again. */
  readonly retried: number;
  /** Failed for good. */
  readonly failed: number;
  /** Schedule ticks this call enqueued. */
  readonly scheduled: number;
  readonly durationMs: number;
}

export interface RunOnceOptions {
  /** Stop claiming new jobs after this many milliseconds. Jobs already running finish. Defaults to 10,000. */
  readonly budgetMs?: number | undefined;
  /** Jobs at once. Defaults to 4. */
  readonly concurrency?: number | undefined;
}

export interface WorkOptions {
  /** Jobs at once. Defaults to 4. */
  readonly concurrency?: number | undefined;
  /** How often to look for new jobs and due schedules when idle. Defaults to `"1s"`. */
  readonly pollInterval?: Duration | undefined;
  /** Abort it to stop: no new jobs are claimed, and the call resolves once running jobs finish. */
  readonly signal?: AbortSignal | undefined;
}

export interface JobRecord {
  readonly id: string;
  readonly type: string;
  /** For a schedule's run, the schedule's name (its `type` is `schedule:<name>`). Otherwise `null`. */
  readonly schedule: string | null;
  readonly status: JobStatus;
  readonly payload: unknown;
  readonly priority: number;
  /** Tries of the current payload. A replace or `retry` starts again from 0. */
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Every time a worker claimed it, whatever was replaced or retried since. */
  readonly claims: number;
  /** When it is due. While running: when its lease ends. */
  readonly runAt: Date;
  readonly lockedUntil: Date | null;
  readonly lockedBy: string | null;
  readonly dedupeKey: string | null;
  readonly lastError: string | null;
  /** What the handler returned, as JSON. */
  readonly result: unknown;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
}

export interface JobListFilter {
  readonly type?: string | readonly string[] | undefined;
  /** Runs of these schedules, by name. Combines with `type` like any other filter (AND). */
  readonly schedule?: string | readonly string[] | undefined;
  readonly status?: JobStatus | readonly JobStatus[] | undefined;
  /** Created at or after this time. */
  readonly since?: Date | undefined;
  /** Newest first, at most this many. Defaults to 100, at most 1,000. */
  readonly limit?: number | undefined;
}

export interface JobTypeHealth {
  readonly type: string;
  readonly pending: number;
  readonly running: number;
  readonly failedLast24h: number;
  /** How long the oldest due job has been waiting, or `null` if none is due. */
  readonly oldestPendingAgeMs: number | null;
  readonly lastSuccessAt: Date | null;
}

export interface ScheduleHealth {
  readonly name: string;
  readonly every: Duration;
  readonly nextRunAt: Date;
  readonly lastRunAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly lastError: string | null;
  /** Succeeded within three intervals. */
  readonly healthy: boolean;
}

export interface JobsHealth {
  readonly types: JobTypeHealth[];
  readonly schedules: ScheduleHealth[];
}

export interface Jobs {
  /** Defines a job type and returns a typed handle to enqueue it. Define each type once, at module scope. */
  define<const TType extends string, TSchema extends StandardSchemaV1>(
    type: TType,
    definition: JobDefinitionWithSchema<TSchema>,
  ): JobHandle<TType, StandardSchemaV1.InferInput<TSchema>>;
  define<const TType extends string, TPayload = unknown>(
    type: TType,
    definition: JobDefinition<TPayload>,
  ): JobHandle<TType, TPayload>;
  /** Runs `run` every `every`, once per tick across all instances, as a job (with retries and history). */
  schedule(
    name: string,
    options: ScheduleOptions,
    run: (context: ScheduleContext) => unknown,
  ): void;
  /** Makes a schedule due now. Returns `false` if it isn't defined. */
  trigger(name: string): Promise<boolean>;
  /** Runs due jobs and schedules until none are left or `budgetMs` runs out. For cron and HTTP triggers. */
  runOnce(options?: RunOnceOptions): Promise<RunSummary>;
  /** The long-running worker. Resolves after `signal` aborts and running jobs finish. */
  work(options?: WorkOptions): Promise<RunSummary>;
  get(id: string): Promise<JobRecord | null>;
  list(filter?: JobListFilter): Promise<JobRecord[]>;
  /** Runs a failed or cancelled job again from attempt 1. */
  retry(id: string): Promise<boolean>;
  /** Cancels a pending job. A running job can't be cancelled. */
  cancel(id: string): Promise<boolean>;
  /** Deletes finished jobs. The only way groundwork removes jobs. */
  prune(options: {
    readonly completedOlderThan: Duration;
    /** Defaults to `completedOlderThan`. */
    readonly failedOlderThan?: Duration | undefined;
  }): Promise<number>;
  health(): Promise<JobsHealth>;
}
