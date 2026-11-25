---
"@vantedev/groundwork": minor
---

**The jobs table has a new column, `claims`. Run `npx drizzle-kit generate` and apply the migration before you deploy this version.** It adds `"claims" integer DEFAULT 0 NOT NULL` to `gw_jobs`, which is instant in Postgres. Until it's applied, a worker's claim fails with an `invalid_config` error that says to migrate.

`claims` counts every time a worker claimed the job, and is now what fences workers: only the worker holding the latest claim can complete or fail a job, or renew its lease. Before, the attempt number did that. Since `retry(id)` starts `attempts` again from 0, a worker that stalled past its lease could find its attempt number current again under the same worker id, and complete a retried job with its old result. `claims` never goes down, so that can't happen. `attempts` is now only the count of tries, and job records have `claims` too.

During a rolling deploy, workers still on 0.3 fence by attempt number, which a `replace` can change under them. Start using `replace` once every worker runs this version.
