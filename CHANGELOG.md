# @vantedev/groundwork

## 0.3.2

### Patch Changes

- 889ab7e: JSON values (job payloads and results, audit `changes` and `metadata`, API-key scopes, IP and origin lists, and `metadata`) are sent to Postgres as text and cast to `jsonb` there, so every driver stores them as JSON. postgres-js runs `JSON.stringify` on parameters the server types as `jsonb`. Drizzle 0.45 turns that off on the postgres-js clients it wraps, but Drizzle 1.0 doesn't, and the JSON groundwork had already encoded was encoded twice: job payloads, results and audit changes were stored as JSON strings, and creating an API key failed with "cannot extract elements from a scalar". Nothing changes on Drizzle 0.45 or with node-postgres.

## 0.3.1

### Patch Changes

- 51bad95: `apiKeys.create()` fixes when recording the key fails (the audit entry, or your `onEvent`):
  
  - A unique violation from that hook no longer makes `create()` draw and insert another key. Only a collision on the new key's own prefix is retried.
  - Without a `tx`, the key it just inserted is deleted before the error is rethrown, so no active key is left whose plaintext nobody received.
  
  The docs no longer say changes are recorded in the same transaction without `tx`. groundwork only calls `db.execute()` and can't open one itself.
- b327209: `apiKeys.rotate()` retries when the new key's prefix collides with an existing one, as `create()` does, instead of failing with a raw database error. A per-key `rateLimit.limit` above 2,147,483,647 is rejected as an invalid argument instead of failing in Postgres.
- 4e7bb46: - A schedule run whose stored payload has no `scheduledAt` (a hand-written row, say) gets the job's creation time, not an Invalid Date.
  - If adding groundwork's cleanup schedules throws when `gw.jobs` is first used (a bad `idempotency.ttl`, say), later accesses throw too. Before, they returned an instance without the cleanup schedules.
- 7667db1: Job and idempotency leases are renewed every third of the lease, also for short leases. The interval used to be at least 1 second, so a `lease: "1s"` was renewed exactly as it ran out, and another worker could claim a job (or another request take over a key) while it was still running. A 2-second lease was renewed at half its length instead of a third.
- ebbfedc: Durations that drive a timer are capped at 24 days, the longest a `setTimeout` can wait, and anything longer is rejected when configured. Before, a job `timeout: "30d"` made every attempt time out after 1 ms. An oversized `lease`, `pollInterval` or rate-limit `timeout` made its timer fire every millisecond. The cap covers job and schedule `timeout`, jobs and idempotency `lease`, `work({ pollInterval })` and the rate limiter's `timeout`.
- fbd9d73: `jobs.work({ signal })` no longer adds an abort listener to `signal` on every idle poll. A long-running worker used to leak one listener per poll (about 86,400 a day at a 1-second poll), until Node warned about a possible memory leak.

## 0.3.0

### Minor Changes

- f2b0df8: Jobs and schedules take a fixed retry ladder: `backoff: { delays: ["30s", "2m", "10m", "30m", "1h"] }`. After the n-th failed attempt the job waits the n-th delay exactly, with no jitter, and once the list runs out the last delay repeats. It's checked when the job is defined: 1 to 100 valid durations, and not together with `base` or `max`. `BackoffOptions` is now a union of the two forms, so an interface that extended it needs to become a type.
- 392e465: Schedules keep to a grid and tolerate a caller that's slightly early. **This changes when schedules run:**
  
  - The next tick is the previous slot plus `every`, not the time the last tick ran plus `every`. Poll lag no longer adds up: a `"1m"` schedule under a worker polling every 5 seconds used to drift to roughly one tick every 60–65 seconds.
  - A tick is due up to `min(every / 10, 5s)` early. A cron that calls `runOnce` every minute, a moment before a `"1m"` schedule's slot, used to run it only every other minute. It now runs every time.
  - As before, missed slots aren't replayed: after an outage the next tick runs at once, and the grid restarts from there. `trigger(name)` restarts the grid too.

## 0.2.0

### Minor Changes

- 377fc30: `audit.query({ offset })` skips that many entries, for admin pages with page numbers, with `count()` for the total. Up to 100,000, and not together with `cursor`. Unlike cursors, offsets can show an entry twice or skip one while the log grows.
- 5191063: `jobs.list({ schedule })` lists one or more schedules' runs by name, and every job record has `schedule`, the schedule's name, or `null` for an enqueued job. The jobs docs also explain why an external cron on the same period as a schedule can run it only every other time.
- 1bda996: `secret` can be a function, called once on first use: the first rate-limit check, key hash or idempotency claim. You can create `gw` at module scope when the environment isn't set during `next build`, and a worker that only cleans up or runs jobs needs no secret. A plain secret is still checked at startup, and both forms derive the same keys. The docs now say that reusing an existing app secret, such as `BETTER_AUTH_SECRET`, is safe.
- 1f1b911: `pinoLogger(logger)` adapts pino, or any logger whose methods take `(context, message)`, to groundwork's `Logger`.
- 971ef36: `apiKeys.verify()` returns the checks behind its headers. On success, `rateLimit` and `quota` (`limit`, `remaining`, `resetAt`), or `null` when the key has none. On a `rate_limited` or `quota_exceeded` failure, the check that denied it. Apps that send their own rate-limit headers no longer parse groundwork's.

## 0.1.0

### Minor Changes

- d6c1960: Package skeleton: ESM-only subpath exports (`@vantedev/groundwork`, `/schema`, `/rate-limit`, `/audit`, `/api-keys`, `/jobs`, `/idempotency`, `/next`, `/testing`), with `drizzle-orm` as the only peer dependency. The root entry exports `GroundworkError`, `isGroundworkError` and the shared `Duration`, `Logger`, `Clock` and `Secret` types.
- ab377d2: Rate limiting, and the table factories it stores its counters in.
  
  - `@vantedev/groundwork/schema`: `groundworkTables({ prefix, schema })` returns Drizzle tables for your schema. The default prefix is `gw_`. When `schema` is set, the returned schema object must be exported too, so drizzle-kit generates `CREATE SCHEMA`.
  - `@vantedev/groundwork/rate-limit`: `createRateLimiter()` with fixed-window and token-bucket rules.
    - Each check is one SQL statement, correct under concurrency across app instances. Time comes from the database unless a `clock` is injected.
    - A request whose `cost` doesn't fit is denied and uses nothing.
    - Results include `RateLimit-Policy`, `RateLimit` (draft-ietf-httpapi-ratelimit-headers-11) and `Retry-After` headers.
    - If the store fails or times out (default `"1s"`), rules fall back to `onError: "memory" | "allow" | "deny"`. A circuit breaker stops retrying for 5 seconds, and the outage is logged once.
    - `reset()` can join a transaction. `cleanup()` deletes in batches.
    - `memoryStore()` and an optional `redisStore()`, which takes any client with `eval` and adds no dependency.
  - `createGroundwork({ db, tables, secret })` exposes the limiter as `gw.rateLimit`.
  - `@vantedev/groundwork/testing`: `createTestClock()`.
- 8a132d1: Audit log.
  
  - `groundworkTables()` now also returns `auditLog` (`gw_audit_log`). It is append-only: identity ids, `occurred_at` defaults to the transaction's `now()`, and every filter column is indexed together with `(occurred_at, id)`.
  - `@vantedev/groundwork/audit`: `createAuditLog({ db, table, actions, entityTypes?, redact?, redactDefaults? })`.
    - Actions and entity types are inferred from the config.
    - `record(event, { tx })` writes inside your transaction; `recordMany` writes up to 1,000 entries in one statement, all or none.
    - Events are validated before anything is sent, and recording throws rather than swallowing errors.
    - `changes` and `metadata` are redacted at any depth, using `DEFAULT_REDACT` plus your rules, and normalised to JSON.
    - `query()` uses keyset pagination on `(occurred_at, id)` and filters by action, actor, entity, request id, time range, literal text search, or any Drizzle `where`. It reads newest first, or oldest first with `order: "asc"`.
    - `count()` takes the same filters; `prune({ olderThan })` deletes in batches.
  - `diff(before, after, { ignore })` returns only the changed fields, as `[before, after]`.
  - `createGroundwork({ audit: { actions } })` exposes the log as `gw.audit`.
- e7b1e91: Scoped API keys.
  
  - `groundworkTables()` now also returns `apiKeys` (`gw_api_keys`). Only an HMAC of each key is stored, under a unique index. The table also keeps a partial index on the previous hash, used during rotation grace periods.
  - `@vantedev/groundwork/api-keys`: `createApiKeys({ db, table, secret, namespace, scopes, rateLimiter })`, or `gw.apiKeys` from `createGroundwork({ apiKeys })`.
    - Keys look like `<namespace>_<12 hex>_<43 base64url>` with a CRC32 checksum suffix. Typos and foreign keys are rejected without a database lookup, and keys without a checksum still verify.
    - Scopes are typed from the config and can be granted as `resource:*` wildcards.
    - `verify(request | headers | key, { scopes, ip, origin })` finds the key, current or within its rotation grace period, in one query.
      - It returns `{ ok: true, key, headers }`, or `{ ok: false, reason, status, response }`. Reasons: `missing`, `malformed`, `invalid`, `revoked`, `expired`, `suspended`, `ip_denied`, `origin_denied`, `forbidden_scope`, `rate_limited`, `quota_exceeded`.
      - The JSON response carries RFC 6750 `WWW-Authenticate` headers.
    - IPv4 and IPv6 CIDR allowlists, which also match IPv4-mapped addresses, and origin allowlists.
    - Per-key rate limit (default 60/min) and daily quota through the rate limiter.
    - Lifecycle: `create`, `update`, `rotate({ grace })`, `suspend({ for })`, `reinstate`, `revoke`, `delete`, `get`, `list`. Every method takes `{ actor, tx }`.
    - `lastUsedAt` and `lastUsedIp` are written at most once a minute, in the background (`waitUntil` hook).
    - `legacyHash` keeps keys from an older system working, and upgrades each one on first use.
    - `redactKeys(text)`.
  - With the audit log wired, every key change is recorded as `api_key.*`, which `gw.audit` accepts automatically. `apiKeyAuditEvent()` maps events for standalone use.
- 1761981: Background jobs and schedules.
  
  - `groundworkTables()` now also returns `jobs` (`gw_jobs`) and `jobSchedules` (`gw_job_schedules`).
    - Status is checked text, not an enum, so nothing extra has to be exported.
    - A partial claim index on `(priority desc, run_at, id)`, so a claim reads only the next few rows.
    - A partial unique index on `(type, dedupe_key)` while a job is pending or running.
  - `@vantedev/groundwork/jobs`: `createJobs({ db, table, schedulesTable, lease })`, or `gw.jobs` from `createGroundwork`.
    - `define(type, { schema, run, maxAttempts, backoff, timeout, priority, onExhausted })` returns a typed handle. Payloads are typed from a Standard Schema (zod, valibot, arktype…), which also validates them, or from `run`'s parameter.
    - `enqueue(payload, { tx, runAt, delay, priority, dedupeKey, maxAttempts })` returns `{ id, created }`.
    - Workers claim batches with `FOR UPDATE SKIP LOCKED` in one statement. Each job is leased, and the lease is renewed while the handler runs; a dead worker's jobs come back when its lease ends. The attempt number fences out late results from a worker that lost its lease.
    - Retries use capped exponential backoff with full jitter. Timeouts abort `context.signal`.
    - `work({ concurrency, pollInterval, signal })` finishes running jobs on abort. `runOnce({ budgetMs, concurrency })` is for cron and HTTP triggers.
    - `schedule(name, { every }, fn)`: each tick runs exactly once across instances, as a job, so it gets retries, history and health. Overlapping ticks are skipped. `trigger(name)` runs a schedule now.
    - `get`, `list`, `retry`, `cancel`, `prune`, and `health()`, which reports per-type queue stats and per-schedule last success, failure and health.
  - `createGroundwork` schedules `gw.rateLimit.cleanup()` hourly when rate limiting is set up.
- 5de6fdf: Idempotency keys and Next.js route helpers.
  
  - `groundworkTables()` now also returns `idempotencyKeys` (`gw_idempotency_keys`). Keys and request fingerprints are stored as HMACs; responses are stored as JSON text.
  - `@vantedev/groundwork/idempotency`: `createIdempotency({ db, table, secret, ttl, lease })`, or `gw.idempotency` from `createGroundwork`.
    - `handle(request, { scope, required, ttl, fingerprint }, handler)` follows draft-ietf-httpapi-idempotency-key-header-08. A completed 2xx or 3xx response is replayed with `Idempotent-Replayed: true`; reuse with a different body, path or method is a 422; a duplicate while the first request runs is a 409; a missing (when `required`) or malformed key is a 400. Errors aren't stored, so clients can retry.
    - Concurrent duplicates run the handler once. A running request holds its key with a lease that is renewed while it runs, so a crashed request frees its key within `lease` (default `"30s"`).
    - `Set-Cookie` and per-request headers are never stored.
    - `run({ scope, key, fingerprint }, fn)` does the same for anything that isn't an HTTP handler, and returns the stored JSON value, typed with `Jsonify<T>`.
    - `cleanup()` deletes expired keys. `createGroundwork` schedules it hourly once you use `gw.jobs` (`jobs: { idempotencyCleanup: false }` turns it off).
  - `@vantedev/groundwork/next`, with no dependency on `next`:
    - `createRouteHelpers(gw, { trustProxy })` returns `withApiKey(scopes, handler)`, `withRateLimit(rule, key, handler)`, `withIdempotency(options, handler)` and `clientIp(request)`. Wrappers nest, and what an outer one adds (`context.apiKey`) is typed in the ones inside.
    - `jobsRoute(gw, { secret, budgetMs, concurrency })`: a bearer-protected HTTP trigger for `gw.jobs.runOnce()`, for Vercel Cron and other schedulers. `?schedule=<name>` runs a schedule now.
    - `getClientIp(request, { trustProxy })` reads only the header you trust: `"vercel"`, `"cloudflare"`, or `{ header, hops }` for `X-Forwarded-For` behind your own proxies. The default, `"none"`, reads nothing.
  - `examples/next-app` uses every module in a Next.js 16 app.
- First public release, as `@vantedev/groundwork` (the unscoped name `groundwork` belongs to another package on npm). Import from `@vantedev/groundwork`, `@vantedev/groundwork/schema`, `@vantedev/groundwork/next` and the other subpaths. New guides cover testing your app and migrating from hand-rolled tables.
