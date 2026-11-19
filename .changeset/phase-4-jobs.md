---
"groundwork": minor
---

Background jobs and schedules.

- `groundworkTables()` now also returns `jobs` (`gw_jobs`) and `jobSchedules` (`gw_job_schedules`).
  - Status is checked text, not an enum, so nothing extra has to be exported.
  - A partial claim index on `(priority desc, run_at, id)`, so a claim reads only the next few rows.
  - A partial unique index on `(type, dedupe_key)` while a job is pending or running.
- `groundwork/jobs`: `createJobs({ db, table, schedulesTable, lease })`, or `gw.jobs` from `createGroundwork`.
  - `define(type, { schema, run, maxAttempts, backoff, timeout, priority, onExhausted })` returns a typed handle. Payloads are typed from a Standard Schema (zod, valibot, arktype…), which also validates them, or from `run`'s parameter.
  - `enqueue(payload, { tx, runAt, delay, priority, dedupeKey, maxAttempts })` returns `{ id, created }`.
  - Workers claim batches with `FOR UPDATE SKIP LOCKED` in one statement. Each job is leased, and the lease is renewed while the handler runs; a dead worker's jobs come back when its lease ends. The attempt number fences out late results from a worker that lost its lease.
  - Retries use capped exponential backoff with full jitter. Timeouts abort `context.signal`.
  - `work({ concurrency, pollInterval, signal })` finishes running jobs on abort. `runOnce({ budgetMs, concurrency })` is for cron and HTTP triggers.
  - `schedule(name, { every }, fn)`: each tick runs exactly once across instances, as a job, so it gets retries, history and health. Overlapping ticks are skipped. `trigger(name)` runs a schedule now.
  - `get`, `list`, `retry`, `cancel`, `prune`, and `health()`, which reports per-type queue stats and per-schedule last success, failure and health.
- `createGroundwork` schedules `gw.rateLimit.cleanup()` hourly when rate limiting is set up.
