---
"groundwork": minor
---

Rate limiting, and the table factories it stores its counters in.

- `groundwork/schema`: `groundworkTables({ prefix, schema })` returns Drizzle tables for your schema. The default prefix is `gw_`. When `schema` is set, the returned schema object must be exported too, so drizzle-kit generates `CREATE SCHEMA`.
- `groundwork/rate-limit`: `createRateLimiter()` with fixed-window and token-bucket rules.
  - Each check is one SQL statement, correct under concurrency across app instances. Time comes from the database unless a `clock` is injected.
  - A request whose `cost` doesn't fit is denied and uses nothing.
  - Results include `RateLimit-Policy`, `RateLimit` (draft-ietf-httpapi-ratelimit-headers-11) and `Retry-After` headers.
  - If the store fails or times out (default `"1s"`), rules fall back to `onError: "memory" | "allow" | "deny"`. A circuit breaker stops retrying for 5 seconds, and the outage is logged once.
  - `reset()` can join a transaction. `cleanup()` deletes in batches.
  - `memoryStore()` and an optional `redisStore()`, which takes any client with `eval` and adds no dependency.
- `createGroundwork({ db, tables, secret })` exposes the limiter as `gw.rateLimit`.
- `groundwork/testing`: `createTestClock()`.
