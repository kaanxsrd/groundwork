# Migrating from hand-rolled tables

Most apps that need groundwork already have a `rate_limits`, `audit_log` or `jobs` table of their own. This page is the plan for moving off them, one module at a time, with no downtime and no big-bang release.

## The approach

1. **Add groundwork next to your tables.** Its tables are prefixed `gw_`, so `gw_rate_limits` sits beside your `rate_limits` and nothing collides. Export only the tables for the module you're moving, then run `drizzle-kit generate`. The migration should contain nothing but `CREATE TABLE` and `CREATE INDEX`; if it touches your own tables, stop and check your schema glob.

   The table names in SQL don't collide, but the TypeScript exports can: if your schema already exports `rateLimits`, `auditLog` or `jobs` (Better Auth's `rateLimit` too, in a barrel that re-exports everything), rename groundwork's, and hand them to `createGroundwork` by its names instead of `import * as tables`:

   ```ts
   // src/db/schema/groundwork.ts
   export const { rateLimits: gwRateLimits, auditLog: gwAuditLog } = groundworkTables();

   // src/lib/groundwork.ts
   createGroundwork({ db, tables: { rateLimits: gwRateLimits, auditLog: gwAuditLog }, secret });
   ```
2. **Switch the code, one module at a time.** Each module works on its own: you can move rate limiting today and the job queue next month.
3. **Carry over the data that matters** with the SQL below. Some modules have nothing worth moving.
4. **Drop the old table later**, in a separate migration, once nothing reads it.

## What happens to the old data

| Module | Old data | How |
| --- | --- | --- |
| [Rate limiting](rate-limiting.md#replacing-a-hand-rolled-limiter) | Let it go | Counters only live for a window. Switch over, and every subject starts with a fresh window. |
| [Audit log](audit.md#moving-from-a-hand-rolled-table) | Copy it | One `insert … select`, in time order. SQL for vante.app's and bubblehouse-dk's tables is on the audit page. |
| [API keys](api-keys.md#moving-from-vanteapp) | Copy it | Copy the rows, and verify with your old hash through `legacyHash` until every key has been used once. No user has to re-issue a key. |
| [Background jobs](jobs.md#replacing-a-hand-rolled-queue) | Move what's pending | Drain the old queue, or move pending jobs over in one statement (below). Finished jobs can stay where they are. |
| [Idempotency keys](idempotency.md#replacing-vaultdrops-withidempotency) | Let it go | Keys are hashed differently. Let the old table's last day of keys expire. |

## Moving pending jobs

Define every job type in groundwork first, with payload schemas that accept the old payloads. Then stop the old worker and move what's waiting, atomically. For vante.app's `jobs`:

```sql
with moved as (
  delete from jobs where status = 'pending'
  returning id, type, payload, attempts, max_attempts, run_at, created_at
)
insert into gw_jobs (id, type, payload, attempts, max_attempts, run_at, created_at)
select id, type, payload, attempts, max_attempts, run_at, created_at from moved;
```

Jobs that were `running` when the worker stopped are left behind: run the old worker once more to finish them, or reset them to `pending` and move them too. Remember that a job can run more than once anyway; see [how jobs run](jobs.md#how-jobs-run).

If you'd rather not move anything, enqueue new jobs through groundwork, keep the old worker running until its queue is empty, then turn it off.

## Per app

These are the apps groundwork was extracted from, and the order that moves each one with the least risk.

### Faultline

- **Rate limiting:** replace the in-memory `Map` with `gw.rateLimit` ([mapping](rate-limiting.md#replacing-a-hand-rolled-limiter)). This also fixes limits that only held per instance.

### vante.app

1. **Rate limiting:** rules map one to one. Replace vante.app's `ipBucket()` with [`ipSubject()`](rate-limiting.md#limiting-by-ip-address), which buckets IPv6 by `/64` the same way, but keeps IPv4-mapped addresses (`::ffff:…`) apart instead of putting them all in one bucket.
2. **Audit log:** copy `audit_logs`, and add every old action name to `audit.actions`.
3. **API keys:** copy `api_keys`, verify with `legacyHash` and the old pepper, and keep country checks in your own code (they're stored in `metadata`).
4. **Jobs:** move pending jobs as above. `scripts/worker.ts` becomes `gw.jobs.work({ signal })`, and `claimInterval` becomes `gw.jobs.schedule`.

### VaultDrop

1. **Rate limiting:** VaultDrop already hashes its subjects; switch the rules, and keep the Redis store if you use one.
2. **Jobs:** each `JOBS` entry becomes a schedule, and the internal jobs route becomes [`jobsRoute`](next.md#jobsroutegw--secret-budgetms-concurrency-).
3. **Idempotency:** the secrets route stores only part of its response, so it uses [`run()`](idempotency.md#without-http-run), which also lets it keep its own error codes.

### bubblehouse-dk

1. **Audit log:** copy `audit_log` (a null actor becomes `system`).
2. **Mail outbox:** enqueue each mail as a job in the order's transaction. Its "send each receipt once, ever" rule isn't something `dedupeKey` does (that only blocks duplicates while a job is waiting or running), so keep a sent-receipts table of your own and check it in the job.
