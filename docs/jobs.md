# Background jobs

Typed background jobs and schedules on your Postgres. Jobs live in a table in your Drizzle schema and are enqueued inside your transaction. They're claimed in batches by any number of workers, retried with jittered backoff, and recovered automatically when a worker dies. A worker can run as a long-lived process or, for serverless, as a budgeted run from cron or an HTTP request.

**When to use something else:** this is a small, dependable job queue, not a workflow engine. If you need job dependencies, fan-out/fan-in, cron expressions, or tens of thousands of jobs a second, use [pg-boss](https://github.com/timgit/pg-boss) or [graphile-worker](https://worker.graphile.org).

## Quickstart

1. Export the tables and generate a migration ([table factories](schema.md)):

   ```ts
   export const { jobs, jobSchedules } = groundworkTables();
   ```

2. Define jobs once, at module scope:

   ```ts
   import { z } from "zod";

   export const sendReceipt = gw.jobs.define("email.receipt", {
     schema: z.object({ orderId: z.string() }), // any Standard Schema: zod, valibot, arktype…
     maxAttempts: 5,
     async run({ orderId }, { signal, attempt }) {
       await mailer.sendReceipt(orderId, { signal });
     },
   });
   ```

3. Enqueue in the transaction that makes the change. If it rolls back, the job never existed:

   ```ts
   await db.transaction(async (tx) => {
     await tx.insert(orders).values(order);
     await sendReceipt.enqueue({ orderId: order.id }, { tx, dedupeKey: `receipt:${order.id}` });
   });
   ```

4. Run a worker:

   ```ts
   // scripts/worker.ts
   const stop = new AbortController();
   for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop.abort());
   await gw.jobs.work({ concurrency: 4, signal: stop.signal });
   ```

   On serverless, call `await gw.jobs.runOnce({ budgetMs: 10_000 })` from a cron-triggered route instead.

## Defining jobs

```ts
gw.jobs.define(type, { schema, run, maxAttempts, backoff, timeout, priority, onExhausted });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `schema` | none | A [Standard Schema](https://standardschema.dev). The payload is checked on enqueue, and again before running; `run` gets the schema's output. Without a schema, annotate `run`'s parameter to type `enqueue`. |
| `run(payload, context)` | required | The handler. What it returns is stored as the job's `result`, which is handy for stats. |
| `maxAttempts` | 5 | Tries before the job fails for good. |
| `backoff` | `{ base: "30s", max: "1h" }` | The wait before a retry is random between 0 and `min(max, base × 2^(attempt−1))` ("full jitter"), so failures don't retry in lockstep. |
| `timeout` | `"5m"` | After this, `context.signal` aborts and the attempt counts as a failure. `false` for no timeout. |
| `priority` | 0 | Higher runs first. |
| `onExhausted(payload, failure, context)` | none | Called once when the last attempt fails, for example to mark a notification as undeliverable. |

`context` has `id`, `type`, `attempt` (1 on the first try), `maxAttempts`, `createdAt` and `signal`. Pass `signal` to `fetch` and database calls, so a timed-out job actually stops.

**Payloads are stored as JSON.** Dates become ISO strings and bigints become strings. Use `z.coerce.date()` (or your library's equivalent) when a payload carries dates. A stored payload that fails the schema (written by an older release, say) fails at once without retrying, since it never would pass.

## Enqueueing

```ts
await job.enqueue(payload, { tx, runAt, delay, priority, dedupeKey, maxAttempts });
// → { id, created }
```

- `tx`: enqueue inside your transaction.
- `runAt` / `delay`: not before a time, or not before `"10m"` from now.
- `dedupeKey`: while a job of the same type and key is pending or running, enqueueing it again returns that job (`created: false`) instead of adding another, even under concurrent enqueues. Once the job finishes, the key is free again. For "only ever once" (one receipt per order, forever), record that in your own table, in the same transaction.

## How jobs run

- **Claiming:** a worker claims up to `concurrency` jobs in one statement, using `FOR UPDATE SKIP LOCKED` (so workers never wait on each other), ordered by priority and due time through a partial index.
- **Leases:** a claimed job is leased to its worker (`lease`, default `"1m"`), and the worker renews the lease while the handler runs. If the worker dies, the lease runs out and another worker picks the job up. There's no fixed "stale after 5 minutes" rule.
- **Fencing:** each claim bumps the job's attempt number, and only the worker holding the latest attempt can complete or fail it. A worker that froze and wakes up late can't overwrite the result of the worker that took over. If its lease is lost, the handler's `signal` aborts.
- **Failures** are retried with backoff until `maxAttempts`, then the job is marked `failed` and `onExhausted` runs. A job whose worker died during its last attempt also fails, rather than running again.
- **At least once:** a worker can finish the work and die before recording it, and then the job runs again. Make handlers idempotent, for example with an idempotency key on the email provider, or by checking your own state first.

Failures are logged as warnings (and errors when exhausted) with the type, id, attempt and error message. Payloads are never logged.

## Workers

```ts
await gw.jobs.work({ concurrency: 4, pollInterval: "1s", signal });
```

`work` keeps `concurrency` jobs running. It looks for more whenever one finishes, and every `pollInterval` while idle. Aborting `signal` stops it claiming; the promise resolves when running jobs have finished, with a summary (`claimed`, `completed`, `retried`, `failed`, `scheduled`). If the database is unreachable it logs once and keeps retrying.

```ts
const summary = await gw.jobs.runOnce({ budgetMs: 10_000, concurrency: 4 });
```

`runOnce` processes due jobs and schedules until nothing is due or the budget is spent, then waits for running jobs to finish. Use it from cron, from an HTTP route, or right after a request (vante.app's "kick"), for example in Next.js `after()`. Keep job timeouts below your platform's request limit.

## Schedules

```ts
gw.jobs.schedule("security.scan", { every: "1m" }, async ({ scheduledAt }) => {
  return { scanned: await runSecurityScan() };
});
```

- **Once per tick, cluster-wide:** a tick is claimed by moving the schedule's `next_run_at` forward with a conditional update, so of all your instances exactly one runs it.
- **A tick runs as a job** (`schedule:<name>`), so it gets retries (3 by default), timeouts, history, `result` and health like any other job.
- **No overlap:** a tick is skipped while the previous one is still pending or running.
- **Timing:** a new schedule runs at once; after that it runs `every` after the last tick. `gw.jobs.trigger(name)` makes it due now. There's no cron syntax.
- **History:** `gw.jobs.list({ schedule: name })` lists a schedule's runs, newest first. Each record's `schedule` is the schedule's name (`null` for enqueued jobs). To run one now and read its result, `trigger(name)`, then `runOnce()`, then `list({ schedule: name, limit: 1 })`.
- **Driven by an external cron:** a tick is due `every` after the last one ran, so a cron that calls `runOnce` every minute can arrive a moment before a `"1m"` schedule is due, and run it only every other minute. Give such schedules an `every` a little under the cron's period (`"50s"` for a 1-minute cron), or call `trigger(name)` from the cron route.

With rate limiting set up, `createGroundwork` registers `groundwork.rate-limit-cleanup` (hourly `gw.rateLimit.cleanup()`) for you, and with idempotency keys, `groundwork.idempotency-cleanup`. They show in `health()` and `list()` next to yours. Turn them off with `jobs: { rateLimitCleanup: false, idempotencyCleanup: false }`.

## Operations

| Method | Effect |
| --- | --- |
| `get(id)`, `list({ type, schedule, status, since, limit })` | Job records: status, attempts, `lastError`, `result`, timestamps. |
| `retry(id)` | Runs a failed or cancelled job again from attempt 1. |
| `cancel(id)` | Cancels a pending job. Running jobs can't be cancelled. |
| `prune({ completedOlderThan: "7d", failedOlderThan: "30d" })` | Deletes finished jobs, in batches. The only way groundwork removes jobs. |
| `health()` | Per type: `pending`, `running`, `failedLast24h`, `oldestPendingAgeMs` (how long the oldest due job has waited), `lastSuccessAt`. Per schedule: next and last runs, last success, failure and error, and `healthy` (a success within three intervals). |

Schedule pruning yourself, for example:

```ts
gw.jobs.schedule("jobs.prune", { every: "1d" }, () => gw.jobs.prune({ completedOlderThan: "7d", failedOlderThan: "30d" }));
```

## Drivers

Every statement the worker runs (claim, renew, complete, fail, tick) is a single statement. It doesn't rely on interactive transactions, and enqueueing in a transaction uses yours. CI tests the `postgres` and `pg` drivers.

## Replacing a hand-rolled queue

- **vante.app:**
  - `enqueueJob(type, payload)` becomes a `define` handle's `enqueue`, and the handler's `run`/`onExhausted` carry over as they are.
  - `scripts/worker.ts` becomes `work({ signal })`.
  - `claimInterval("security.scan", 60_000)` becomes `schedule("security.scan", { every: "1m" }, …)`.
  - `kickBackgroundWork` becomes `runOnce` in `after()`.
  - What changes: batches instead of one job at a time, leases instead of the 5-minute stale-lock rule, and jittered, capped backoff.
- **VaultDrop:**
  - Each entry of `JOBS` (`everySeconds` + `run` returning stats) becomes a `schedule`; the stats land in the tick's `result`.
  - `jobHealth()` becomes `health().schedules`, `recentJobRuns()` becomes `list({ schedule: names })`, and `?job=<name>` becomes `trigger(name)` then `runOnce()`.
  - Retries become the schedule's `maxAttempts`, without blocking the run.
