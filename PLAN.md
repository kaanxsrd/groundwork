# Groundwork plan

> **Working name.** Postgres-only, Drizzle-native building blocks for the plumbing every app rebuilds: rate limiting, audit logs, scoped API keys, background jobs and idempotency keys.
>
> Status: draft, 2026-11-19. This file is the source of truth. Update it as decisions are made.

## 1. Why this exists

The same pieces have been written again in almost every app I've built:

| Piece | Where it exists today | What's weak about it |
| --- | --- | --- |
| Rate limiting | `vante.app` (Postgres fixed window + memory fallback), `VaultDrop` (Postgres fixed window, hashed subjects, optional Redis), `bubblehouse-dk` (`app_rate_limit`), `Hookline` (Redis token bucket), `Faultline` (in-memory `Map`) | Five implementations. Faultline's only works inside one process. |
| Audit log | `vante.app` (`audit_logs`), `bubblehouse-dk` (`audit_log` with `changes`), plus audit code in `vante-new-frontend` and `Hookline` | Different columns everywhere, no shared diff or redaction |
| Scoped API keys | `vante.app` (prefix + HMAC + rotation grace + scopes + suspend), key tables in `VaultDrop` and `Hookline` | Only vante.app's is complete, and it can't be reused |
| Background jobs | `vante.app` (`jobs` + `SKIP LOCKED` + backoff + `scripts/worker.ts`), `VaultDrop` (runner + health + HTTP trigger), `bubblehouse-dk` (mail outbox + `run-jobs.ts`) | Claims one job at a time, untyped payloads, enqueue can't join a transaction, fixed stale-lock timeout, no jitter |
| Idempotency keys | `VaultDrop` | Only in one app |

**For me:** install one package instead of copying code, so a fix lands in every app.

**For everyone else:** many people self-host Next.js + Drizzle + Postgres. The existing options each cover one piece, and most need Redis or a hosted service:

- `rate-limiter-flexible` has a Postgres store, but it manages its own table outside Drizzle.
- `@upstash/ratelimit` needs Redis.
- `pg-boss` and `graphile-worker` run their own schema and migrations.
- Unkey is a service.
- better-auth's `apiKey` plugin ties keys to better-auth users.

**The pitch:** the tables live in *your* Drizzle schema, migrations go through *your* drizzle-kit, every write can join *your* transaction, every name is typed, and you don't need Redis.

## 2. Principles

1. **Postgres is the only infrastructure.** Redis can be an optional adapter, never a requirement.
2. **Tables live in the app's Drizzle schema.** The library exports table factories. The app re-exports them, and the app's drizzle-kit generates migrations. The library never runs DDL.
3. **Every write accepts a transaction** (`{ tx }`), so audit entries and enqueued jobs commit or roll back with the business change.
4. **Names are defined once and typed everywhere.** The app declares scopes, audit actions and job types, and TypeScript checks every use. Use `const` type parameters so callers never need `as const`.
5. **The core is framework-agnostic.** It takes Web `Request`/`Headers`. Next.js helpers live in a separate entry point.
6. **Secure by default:**
   - HMAC-hash API keys and rate-limit subjects (no raw keys, no raw IPs used as keys).
   - Use timing-safe comparisons.
   - Redact configured audit fields.
   - Never log secrets.
7. **Testable:** inject `clock` and `logger`, and use no global state outside an explicit memory fallback.
8. **Small:** `drizzle-orm` is the only peer dependency. Payload validation uses Standard Schema (types only), so zod, valibot and arktype all work.
9. **One database round trip on hot paths** (rate-limit check, key verify) wherever possible.

## 3. Non-goals for v1

- Auth, sessions and users (better-auth covers these).
- UI or dashboard components (maybe headless helpers later).
- MySQL, SQLite, D1 or edge runtimes.
- A hosted service.
- Competing with pg-boss at scale: no workflows, fan-out or cron-expression parser in v1.

## 4. Package layout

```
groundwork/
  src/
    index.ts        createGroundwork() wiring everything together
    schema/         table factories
    rate-limit/
    audit/
    api-keys/
    jobs/
    idempotency/
    next/           Next.js route helpers (imports server-only)
    testing/        fake clock, db reset, helpers for apps testing their own code
    internal/       durations ('15m', '90d'), HMAC/HKDF, CIDR matching, errors
  tests/
    unit/
    integration/    real Postgres via docker compose
  examples/
    next-app/       minimal Next.js app using every module
  docs/
```

Subpath exports: `groundwork`, `groundwork/schema`, `groundwork/rate-limit`, `groundwork/audit`, `groundwork/api-keys`, `groundwork/jobs`, `groundwork/idempotency`, `groundwork/next`, `groundwork/testing`. Each module also works standalone (`createRateLimiter({ db, table, secret })`). `createGroundwork` just wires them together.

**Tooling** (match my other repos):

- Bun 1.4 for dev and tests, TypeScript strict at the same major as my apps, Biome.
- Build ESM + `.d.ts` with tsdown. If its declaration output doesn't work with our TypeScript version, use plain `tsc` (decide in Phase 0).
- `bun test`, and Postgres through `docker compose`.
- GitHub Actions CI:
  - full suite under Bun;
  - a smoke script against the built package under Node 22;
  - the oldest and newest supported Postgres majors;
  - both `postgres` (postgres-js) and `pg` (node-postgres) drivers.
- Changesets for versions and CHANGELOG, and npm publish with provenance.
- ESM only.

**Drivers:** accept any Drizzle `PgDatabase`. The jobs module needs interactive transactions, so document that `neon-http` won't work for jobs (use the Neon websocket driver or a pooled TCP driver).

## 5. API sketch (target developer experience)

```ts
import { groundworkTables } from "groundwork/schema";

export const { rateLimits, auditLog, apiKeys, jobs, jobSchedules, idempotencyKeys } =
  groundworkTables({ prefix: "gw_" });
```

```ts
import { createGroundwork } from "groundwork";
import * as tables from "@/db/schema/groundwork";

export const gw = createGroundwork({
  db,
  tables,
  secret: env.GROUNDWORK_SECRET,
  logger,
  audit: {
    actions: ["post.create", "post.update", "post.delete", "api_key.revoke"],
    redact: ["password", "token"],
  },
  apiKeys: {
    namespace: "vnt",
    scopes: { "posts:read": "Read posts", "posts:write": "Create and edit posts" },
  },
});
```

The single `secret` is split into per-purpose subkeys with HKDF (`rate-limit`, `api-keys`, `idempotency`). Secret rotation (`previousSecrets`) is a later feature. Rotating the secret today invalidates every API key, so the README must say so.

**Rate limiting**

```ts
const loginLimit = gw.rateLimit.rule({ name: "login:ip", limit: 5, window: "15m" });
const apiLimit = gw.rateLimit.rule({ name: "api", algorithm: "token-bucket", rate: 10, per: "1s", burst: 120 });

const result = await loginLimit.check(ip);
if (!result.allowed) return new Response("Too many attempts", { status: 429, headers: result.headers });
```

**Audit log**

```ts
await db.transaction(async (tx) => {
  const [before] = await tx.select().from(posts).where(eq(posts.id, id));
  const [after] = await tx.update(posts).set(input).where(eq(posts.id, id)).returning();
  await gw.audit.record(
    {
      actor: { type: "user", id: user.id },
      action: "post.update",
      entity: { type: "post", id },
      changes: diff(before, after),
    },
    { tx },
  );
});
```

**API keys**

```ts
const { key, record } = await gw.apiKeys.create({
  name: "CI deploy",
  scopes: ["posts:write"],
  ownerId: user.id,
  expiresIn: "90d",
});

const auth = await gw.apiKeys.verify(request, { scopes: ["posts:write"] });
if (!auth.ok) return auth.response;
auth.key.id;
```

`key` is shown once. Only the hash is stored. `auth.response` is a JSON 401/403/429 with the right headers.

**Jobs**

```ts
export const sendReceipt = gw.jobs.define("email.receipt", {
  schema: z.object({ orderId: z.string() }),
  maxAttempts: 5,
  async run({ orderId }, ctx) {},
});

await db.transaction(async (tx) => {
  await tx.insert(orders).values(order);
  await sendReceipt.enqueue({ orderId: order.id }, { tx, dedupeKey: `receipt:${order.id}` });
});

gw.jobs.schedule("rate-limit-cleanup", { every: "1h" }, () => gw.rateLimit.cleanup());

await gw.jobs.work({ concurrency: 4, signal });
```

`gw.jobs.work()` is the long-running worker. For serverless or cron, use the HTTP trigger:

```ts
import { jobsRoute } from "groundwork/next";
export const POST = jobsRoute(gw, { secret: env.CRON_SECRET, budgetMs: 10_000 });
```

The sketch is a direction, not a contract. Improve it if a better shape appears, and log why.

## 6. Module specs

### 6.1 Rate limiting

- Algorithms:
  - **fixed window**: a single upsert, as in `vante.app`;
  - **token bucket**: a single upsert that computes the refill in SQL, porting Hookline's Lua script.
  - Sliding window is a later feature.
- `check(subject, { cost })` makes one round trip and returns `{ allowed, limit, remaining, resetAt, retryAfter, headers }`.
- Keys are stored as `HMAC(name + subject)`, so raw IPs never reach the table.
- `onError: "memory" | "allow" | "deny"`, default `"memory"`. Log the fallback once, not on every request.
- `headers`: `Retry-After`, plus the IETF RateLimit header fields. Check the current draft for the exact field names.
- `reset(subject)`, and `cleanup()` to delete expired rows. It's registered as a schedule automatically when the jobs module is used.
- **Decided in Phase 1** (details in the Decisions log):
  - a request whose cost doesn't fit is denied and uses nothing, in both algorithms;
  - time comes from the store (Postgres `clock_timestamp()`, Redis `TIME`) unless a `clock` is injected;
  - the result has `retryAfterMs` instead of `retryAfter`, plus `degraded`;
  - an optional `redisStore()` takes any client with `eval(script, keys, args)`, so there's no Redis dependency.
- **Must-pass tests:**
  - 100 concurrent checks against `limit: 10` allow exactly 10;
  - window rollover with a fake clock;
  - token-bucket refill math;
  - the memory fallback is used when the DB is down.

### 6.2 Audit log

- `record(event, { tx })` and `recordMany`. Append-only: the library never updates or deletes rows except in `prune`.
- An event has:
  - an actor: `{ type: "user" | "api_key" | "system" | string, id?, label? }`;
  - an action (typed), and an optional entity `{ type, id }`;
  - an optional `summary`, `changes`, `metadata`, `ip` and `requestId`.
- `diff(before, after, { ignore })` returns only the changed fields as `{ field: [before, after] }`.
- Redaction replaces configured keys anywhere in `changes` and `metadata` with `"[redacted]"`.
- `query({ action, actorId, entity, from, to, cursor, limit })` uses keyset pagination on `(occurred_at, id)`.
- `prune({ olderThan: "365d" })`.
- Docs include a SQL snippet that revokes `UPDATE`/`DELETE` on the table from the app role, for people who want it tamper-resistant.
- **Must-pass tests:**
  - a record inside a rolled-back transaction disappears;
  - redaction works on nested objects;
  - pagination returns no duplicates or gaps under concurrent inserts.

### 6.3 Scoped API keys

- Key format: `<namespace>_<12-hex prefix>_<43-char base64url secret>` (vante.app's format), plus an optional CRC32 checksum suffix. The checksum rejects typos without a DB hit and helps secret scanners spot leaked keys.
- Store `HMAC-SHA256(key)` and look keys up by that hash through a unique index.
- Lifecycle:
  - `create`, `update`, `revoke(reason)`, `suspend(duration, reason)` and `reinstate`;
  - `rotate({ grace: "24h" })`, which keeps the previous hash valid until the grace period ends;
  - `expiresAt`, and `list` / `get`.
- `verify(requestOrRawKey, { scopes, ip, origin })` returns a discriminated union:
  - `{ ok: true, key }`, or
  - `{ ok: false, reason, status, response }`, where `reason` is one of `missing | malformed | invalid | revoked | expired | suspended | forbidden_scope | ip_denied | origin_denied | rate_limited | quota_exceeded`.
- Scopes match exactly or by `resource:*`. Scope names are typed from the app's config.
- IP allowlist supports IPv4 and IPv6 CIDR. Test this heavily.
- Each key gets its own rate limit and an optional daily quota, both through 6.1.
- `lastUsedAt`/`lastUsedIp` are written at most once a minute per key, not on every request.
- An optional `onEvent` hook (create, rotate, revoke, suspend) writes to the audit log automatically when both modules are wired.
- **Must-pass tests:**
  - every `reason` path;
  - the rotation grace window (old key works before it ends and fails after);
  - CIDR edge cases;
  - a malformed key never hits the DB.

### 6.4 Background jobs

- `define(type, { schema, run, maxAttempts, backoff, timeout })` returns a typed handle with `enqueue`.
- `enqueue(payload, { tx, runAt, delay, priority, dedupeKey })`. `dedupeKey` is enforced by a partial unique index while the job is pending or running.
- **Claim:** one statement claims a batch atomically. It runs `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *` and sets `status = running`, `locked_until = now() + lease`, `attempts + 1` and `locked_by`.
- **Crash recovery:** running jobs whose `locked_until < now()` can be claimed again. This replaces vante.app's fixed 5-minute stale-lock rule.
- **Backoff:** exponential with full jitter, capped. `onExhausted` hook.
- **Timeout:** the handler gets `ctx.signal` (an AbortSignal) and `ctx.attempt`.
- `runOnce({ budgetMs, concurrency })` returns counts. It's for HTTP or cron triggers and replaces the `run-jobs.ts` + `CRON_SECRET` pattern.
- `work({ concurrency, pollInterval, signal })` is the long-running loop. On abort it finishes in-flight jobs before exiting. LISTEN/NOTIFY wake-up is a later feature.
- **Schedules:** `schedule(name, { every }, fn)`. A row in `job_schedules` is claimed with a conditional update, so only one instance runs each tick. This replaces vante.app's `claimInterval`. There's no cron syntax in v1.
- **Operations:**
  - `retry(id)`, `cancel(id)` and `prune({ completedOlderThan })`;
  - `health()`: per job type, the pending, running and failed (last 24h) counts, the oldest pending age and the last success. This is VaultDrop's `jobHealth`.
- **Must-pass tests:**
  - 8 workers and 500 jobs: every job completes exactly once;
  - a "killed" worker's jobs are recovered after the lease ends;
  - a job enqueued in a rolled-back transaction never runs;
  - `dedupeKey` blocks duplicates;
  - two instances never run the same schedule tick.

### 6.5 Idempotency keys

- `withIdempotency(request, { scope, ttl }, handler)` reads the `Idempotency-Key` header and stores a hash of the request body:
  - **same key and body, request completed:** replay the stored response;
  - **same key, different body:** 422;
  - **same key, request still in progress:** 409.
- Based on VaultDrop's `idempotency` table.
- **Must-pass tests:**
  - concurrent duplicates: the handler runs once;
  - replay returns the same status and body;
  - the TTL expires.

### 6.6 `groundwork/next`

- `withApiKey(scopes, handler)`, `withRateLimit(rule, keyFn, handler)`, `jobsRoute(gw, { secret, budgetMs })` and `withIdempotency`.
- `getClientIp(headers, { trustProxy })`. Proxy headers are untrusted by default. Presets: `vercel`, `cloudflare` (`cf-connecting-ip`), `x-forwarded-for` with a hop count.
- Read the installed Next.js docs before writing this. Next 16 has breaking changes.

## 7. Phases

Each phase ends with:

- `bun run check` green and all tests green;
- a docs section for what was built;
- a changeset;
- this file updated (checkboxes and the Decisions log);
- a report to me.

Don't start the next phase until I approve.

### Phase 0: Repo setup
- [x] `package.json` with subpath exports, Bun, TypeScript strict, Biome, tsdown (or `tsc`) build
- [x] `docker-compose.yml` with Postgres, plus `db:up` / `db:down` scripts like my other repos
- [x] Test harness: per-test-file schema or database isolation, migrations generated by drizzle-kit from the table factories
- [x] CI: lint, typecheck, Bun tests against Postgres (2 majors × 2 drivers), Node smoke test of the built output
- [x] Changesets, LICENSE (see Open decisions), README skeleton, CONTRIBUTING, SECURITY
- [x] `internal/`: durations, HMAC/HKDF, errors. CIDR can wait for Phase 3.
- [x] Spend 30 minutes checking the alternatives in section 1 again, and note anything worth copying or any reason to drop a module
- **Done when:** CI is green with one real integration test that creates tables and talks to Postgres.

### Phase 1: Schema factories + rate limiting
- [x] `groundworkTables({ prefix, schema })`, with every table generated by the same factory
- [x] Fixed-window and token-bucket rules, failure modes, headers, `reset`, `cleanup`
- [x] Optional Redis store for rate limiting (in v1, decided 2026-11-19)
- [x] All 6.1 must-pass tests
- **Done when:** the Faultline in-memory limiter could be swapped out with no loss of features.

### Phase 2: Audit log
- [ ] `record`, `recordMany`, `diff`, redaction, `query`, `prune`, typed actions
- [ ] All 6.2 must-pass tests
- **Done when:** vante.app's and bubblehouse-dk's audit needs are covered.

### Phase 3: Scoped API keys
- [ ] Full lifecycle, `verify`, CIDR, per-key limit and quota through Phase 1, the audit hook through Phase 2
- [ ] All 6.3 must-pass tests
- **Done when:** everything vante.app's `src/features/api-keys` does is possible, except country checks (out of scope).

### Phase 4: Background jobs
- [ ] `define`/`enqueue` (in transactions), batch claim, leases, backoff, timeouts, `runOnce`, `work`, schedules, `health`, ops
- [ ] All 6.4 must-pass tests, including the multi-worker race test
- **Done when:** vante.app's `worker.ts` + `features/jobs` and VaultDrop's runner can both be replaced.

### Phase 5: Idempotency + Next.js helpers + example
- [ ] 6.5 and 6.6
- [ ] `examples/next-app` uses every module end to end and runs in CI
- **Done when:** the README quickstart works copy-pasted into a fresh Next.js app.

### Phase 6: Docs + 0.1 release
- [ ] README in the same style as my other repos (banner, badges, quickstart, a short section per module, a comparison table with honest trade-offs)
- [ ] `docs/` with one page per module, plus migration notes for moving from hand-rolled tables
- [ ] Publish `0.1.0` with provenance

### Phase 7: Dogfooding, then 1.0
- [ ] Faultline: swap the in-memory limiter (this fixes the multi-instance problem)
- [ ] vante.app: rate limiting, audit, API keys, jobs
- [ ] VaultDrop: rate limiting, jobs, idempotency
- [ ] bubblehouse-dk: audit, mail outbox through jobs
- [ ] For each app, record the lines removed and any API pain it exposed, and fix that pain in groundwork, not in the app
- **1.0 when:** at least 2 apps run it in production, there are no open correctness bugs, and the public API is documented and stable.

## 8. Reference code (sibling folders)

Read these before writing each module. Keep what works and fix what section 1 calls weak.

- **Rate limiting:**
  - `../vante.app/src/lib/rate-limit.ts`
  - `../vante.app/src/db/schema/system.ts` (`rate_limits`)
  - `../VaultDrop/src/server/ratelimit.ts`
  - `../Hookline/apps/web/lib/api/rate-limit.ts` (token bucket)
  - `../Faultline/apps/web/lib/rate-limit.ts` (what we replace first)
- **Audit:**
  - `../vante.app/src/db/schema/system.ts` (`audit_logs`)
  - `../bubblehouse-dk/src/server/db/schema/operations.ts` (`audit_log`)
- **API keys:**
  - `../vante.app/src/db/schema/api.ts`
  - `../vante.app/src/features/api-keys/` (`crypto.ts`, `service.ts`, `scopes.ts`)
- **Jobs:**
  - `../vante.app/src/features/jobs/` (`queue.ts`, `scheduler.ts`, `retention.ts`) and `../vante.app/scripts/worker.ts`
  - `../VaultDrop/src/server/jobs/runner.ts`, `../VaultDrop/src/app/api/internal/jobs/route.ts` and `../VaultDrop/scripts/run-jobs.ts`
  - `../bubblehouse-dk/src/server/jobs/` (mail outbox) and `../bubblehouse-dk/scripts/run-jobs.ts`
- **Idempotency:** `../VaultDrop/src/server/db/schema/app.ts` (the `idempotency` table and `usage_counters`)

## 9. Open decisions (ask me)

- **Name and npm scope:** `groundwork` is a working name. Check npm and GitHub before Phase 6.
- **License:** MIT recommended. My apps use GPL-3.0, but GPL on a *library* stops many companies from using it. **Decided 2026-11-19: MIT.**
- **Redis adapter for rate limiting** in v1 or later? Hookline uses Redis today. **Decided 2026-11-19: in v1.**
- **Minimum Postgres version.** **Decided 2026-11-19: 16. CI tests 16 and 18.**
- **Default table prefix:** `gw_`, or plain names (`rate_limits`) that might clash with tables the apps already have? **Decided 2026-11-19: `gw_`.**

## 10. Decisions log

Add one line per decision: `YYYY-MM-DD: decision, and why`.

- 2026-11-19: Postgres-only, Drizzle-native, a single package with subpath exports, ESM only.
- 2026-11-19: License MIT, minimum Postgres 16, default prefix `gw_`, Redis rate-limit adapter in v1 (owner's answers to section 9). CI tests Postgres 16 and 18; 19 is only at rc1 on Docker Hub, and 14 reached EOL on 2026-11-12.
- 2026-11-19: Build with plain `tsc` (TypeScript 7.0.2, the apps' major), not tsdown. tsdown 0.23.7 works, but it warns that its TS 7.0 declaration path is deprecated and will be removed in its next minor. `tsc` gives unbundled ESM, `.d.ts` files and maps, one output file per source file. Revisit once TypeScript 7.1 is stable.
- 2026-11-19: Relative imports end in `.ts`, using `module: nodenext` and `rewriteRelativeImportExtensions`. Bun and drizzle-kit load the sources as they are, and `tsc` rewrites them to `.js`. The emitted `.d.ts` files keep `.ts` specifiers. The smoke test shows TypeScript 5.9, 6.0 and 7.0 resolve them under `nodenext` and `bundler`, with `skipLibCheck` off.
- 2026-11-19: The test harness gives each test file its own database, cloned with `CREATE DATABASE … TEMPLATE` from a template migrated once from the drizzle-kit output. This is stronger isolation than per-file schemas, because drizzle-kit SQL can contain `"public".` references. The template name contains a hash of the migrations. Building and cloning run under an advisory lock, so `bun test --parallel` is safe, and CI runs the tests both ways. Stale clones are dropped after an hour.
- 2026-11-19: Until Phase 1 brings the factories, the harness runs on a fixture probe table (`tests/fixtures/schema.ts`). Phase 1 replaces it with `groundworkTables()`, exactly as an app would. `db:drift` checks the committed migrations against the fixture schema in a temp copy. drizzle-kit exits 0 after some failures, so the check requires drizzle-kit's success message instead of trusting the exit code.
- 2026-11-19: CI starts Postgres with the repo's `docker-compose.yml` (tmpfs, `fsync=off`, `max_connections=300`) instead of a `services:` container, so CI and laptops run the same server. GitHub services can't pass server flags.
- 2026-11-19: The smoke test installs the packed tarball into a project in the OS temp dir, outside the repo, so nothing resolves from the repo's `node_modules`. It imports every subpath on Node 22, checks that internals are blocked by `exports`, runs publint and attw, and type-checks a consumer with `@ts-expect-error` lines, which fail if the types collapse to `any`.
- 2026-11-19: `Duration` is the template literal `` `${number}${"ms"|"s"|"m"|"h"|"d"|"w"}` ``. Bare numbers are rejected so `60` can't mean seconds when ms were meant. Months and years are left out because their length varies.
- 2026-11-19: Subkeys come from HKDF-SHA256 with salt `groundwork/v1` and info `groundwork/v1/<purpose>`, 32 bytes each, from a secret of at least 32 bytes. These strings are frozen as part of the storage format: a golden-value test fails if they change, and a second test checks them against RFC 5869 written out with plain HMAC. Multi-part HMAC input is length-prefixed, so `["ab","c"]` and `["a","bc"]` can't collide. This fixes the ambiguity in PLAN's `HMAC(name + subject)`.
- 2026-11-19: One error class, `GroundworkError`, with a typed `code` (`invalid_config`, `invalid_argument` so far). `isGroundworkError()` checks a `Symbol.for` brand, so it still works when two copies of the package are installed. Expected outcomes (a denied check, a rejected key) are result values, not throws.
- 2026-11-19: The `Logger` interface takes `(message, context)`, like vante.app's logger and `console`. Only `warn` and `error` are required. pino needs a one-line adapter, which is documented. By default warnings and errors go to `console` with a `[groundwork]` prefix. "Log once" state lives in a per-instance wrapper, not in module globals.
- 2026-11-19: `Clock` is `{ now(): Date }`. Whether rate limiting reads time from the clock or from Postgres is a Phase 1 question (see section 11).
- 2026-11-19: The `drizzle-orm` peer range is `^0.45.0`, the version the apps use. 1.0 is at rc.5. Test it and widen the range before 0.1.0, because a peer mismatch makes `npm install` fail.
- 2026-11-19: Engines `node >=22`. Bun 1.4 is what we test. Biome uses double quotes (Faultline, VaultDrop and Hookline do; vante.app uses single). Markdown is excluded from Biome, because Biome 2.6 reformats it, including this file.
- 2026-11-19: The changesets release workflow (publish with provenance) waits for Phase 6. A workflow that can publish shouldn't exist before there's something to publish. `package.json` has no `repository` field until the name is decided, and npm provenance requires one.
- 2026-11-19 (Phase 1): The owner replied "continue" to the Phase 0 report, which I took as approval of the section 11 rate-limit proposals: store time by default, and a cost that doesn't fit uses nothing. vante.app, VaultDrop and Faultline all count denied hits, so one oversized batch burns the window. Redis comes through a structural `eval` client.
- 2026-11-19: One `gw_rate_limits` table serves both algorithms: `key`, `rule`, `used`, `updated_at`, `expires_at`, with an index on `expires_at`. A token bucket stores tokens taken (`used`), not tokens left, so a missing row means "nothing used" for both algorithms and `cleanup()` has one rule. The `rule` column is plaintext for operators. The subject never is.
- 2026-11-19: Fixed windows start at a subject's first request (like vante.app and Faultline), not at epoch-aligned boundaries (VaultDrop's way), so subjects don't all reset together. The up-to-2× burst across a boundary is documented. Calendar-aligned windows (for daily quotas) can be an additive option in Phase 3 if quotas need them.
- 2026-11-19: Each check is one statement. `INSERT … ON CONFLICT DO UPDATE … WHERE <fits>` locks the row and re-checks the latest version, and an outer `LEFT JOIN` reads the current row when nothing was consumed. Denials therefore cost no second query. A denial computed from a slightly stale snapshot clamps `remaining` below `cost`. A mutation test (dropping the `WHERE`) fails 17 tests, including both 100-way races.
- 2026-11-19: Storage key = HMAC over `["rl1", algorithm, rule, subject]`, length-prefixed, with a golden test. The algorithm is part of the key, so two rules with the same name but different algorithms never share a row. Rule names are limited to `[A-Za-z0-9_.:/-]{1,128}`, because they go into structured-field headers. `limit`, `rate` and `burst` are positive integers (the header's `q` must be an integer). `cost` is any finite number ≥ 0, and `cost: 0` peeks.
- 2026-11-19: Headers follow draft-11. `RateLimit-Policy: "name";q;w` describes a token bucket by its sustained rate in whole seconds. `RateLimit: "name";r;t` uses `t` = `Retry-After` when denied (draft section 6). There are no `X-RateLimit-*` or old `RateLimit-Limit`-style headers (VaultDrop, Hookline); apps can build them from the result fields.
- 2026-11-19: Failure handling:
  - `onError` defaults to `"memory"` and can be overridden per rule; default `timeout` is `"1s"`.
  - After a failure, a circuit breaker skips the store for 5 seconds, so a dead database doesn't add a connect timeout to every request.
  - Each outage is logged once at `error`, and recovery at `info`.
  - The memory fallback belongs to each limiter instance, which fixes vante.app's module-global `Map`. It's a bounded LRU (10k). Denied hits refresh recency, found by a test: otherwise a client being limited drifts to the front, gets evicted and gets a fresh allowance.
- 2026-11-19: `check` doesn't take `{ tx }`, despite principle 3. A failed login usually rolls back, and its attempt must still count. A check inside a long transaction would also hold the counter's row lock. `reset` takes `{ tx }` (Postgres store only; other stores throw).
- 2026-11-19: `cleanup()` deletes in batches of 5,000 with `FOR UPDATE SKIP LOCKED` and re-checks expiry on delete, so it never waits on, or deletes, a row a check is extending. It stays manual until Phase 4 schedules it.
- 2026-11-19: The Redis store is one Lua script with the SQL store's semantics. It uses `TIME` by default. Its TTLs are relative (`PEXPIRE` plus 1 s of slack), so an injected clock far from real time can't expire keys early. Replies are strings, because Redis truncates Lua numbers. It runs `EVAL` every time; `EVALSHA` caching is a possible optimisation.
- 2026-11-19: `GroundworkDatabase` is the structural `{ execute(query) }`. It accepts every driver, schema-typed databases and transactions. Results are normalised (array vs `{ rows }`), and times are selected as epoch ms in `float8` so both drivers return plain numbers.
- 2026-11-19: `groundworkTables({ schema })` returns the `PgSchema`, because without it exported drizzle-kit omits `CREATE SCHEMA` (verified). Every name is validated eagerly, because Drizzle runs `extraConfig` lazily (found by a test). Prefix and schema must be lower case.
- 2026-11-19: `createGroundwork()` checks `db`, `tables` and the secret at startup, but builds each module lazily, so a missing table throws on first use. That way an app that only uses audit later won't need a rate-limit table.
- 2026-11-19: Public option types accept explicit `undefined`, for consumers on `exactOptionalPropertyTypes`. The rule-options union marks the other algorithm's fields `?: never`, because otherwise `{ limit, window, rate }` type-checks: TypeScript's excess-property check passes for unions when any member has the property.
- 2026-11-19: Faultline parity is shown by a differential test against a model of its limiter. I wrote the model from its behaviour rather than copying the code: Faultline is GPL-3.0 and this repo is MIT. 15,000 random cost-1 operations give identical answers. With batches, groundwork lets strictly more through without exceeding the limit. The one change for callers is that `check` is async.
- 2026-11-19: The smoke test now migrates a real database and rate-limits through the packed package on Node. The consumer type check keeps `skipLibCheck` off but ignores errors located inside `node_modules/drizzle-orm/`: its sqlite and singlestore declarations fail under TypeScript 5.9. Errors anywhere else, including our `.d.ts` files, fail the step, and a planted error proves it.
- 2026-11-19: Dependency changes:
  - removed tsdown (unused since the Phase 0 build decision);
  - added ioredis and redis as devDependencies, for the Redis store tests only;
  - Redis 8 is in docker compose and CI.
  
  The fixture schema now calls `groundworkTables()` twice, once with the default and once with prefix `alt_` in schema `groundwork_alt`. Its migration replaces Phase 0's probe table.

## 11. Alternatives check (2026-11-19)

The Phase 0 re-check of section 1. Versions are from the npm registry. Two claims were confirmed against the published tarballs: the pg-boss Drizzle adapter and `RateLimiterDrizzle`. The rest comes from each project's docs and changelogs.

**What changed since section 1 was written**

- **pg-boss 12.38** can now enqueue inside the app's Drizzle transaction (`fromDrizzle(tx)`), and transactional workers get a `tx` too. It still owns a `pgboss` schema and migrates on `start()`. ([adapters](https://pgboss.io/api/adapters), [workers](https://pgboss.io/api/workers))
- **rate-limiter-flexible 11.5** ships `RateLimiterDrizzle`. The table lives in your Drizzle schema, and each consume is one atomic upsert (made atomic in 11.4.0, 2026-11-08). It has fixed window only, uses the app's clock, takes no `tx`, and stores plain-string keys. ([wiki](https://github.com/animir/node-rate-limiter-flexible/wiki/Drizzle))
- **better-auth's API keys** moved to `@better-auth/api-key`. It has no rotation and no IP allowlist, and hashes with unkeyed SHA-256.
- **Unkey** shipped rotation with a 15 m–24 h grace period and root-key IP allowlists. Its open-source status is unclear: the GitHub repo returned 404 on 2026-11-19.
- No library bundles these five pieces. The nearest small ones are drizzle-audit (a `pgAuditTable()` factory that intercepts ORM writes), @absolutejs/queue-postgres (SKIP LOCKED with the table in your schema) and keypal (keys with a Drizzle adapter).

**Reasons to drop a module:** none. **To reposition:** jobs, and the fixed-window half of rate limiting. Proposals are below. None of them is applied yet, because they change the specs in section 6.

1. **Jobs (6.4):** "enqueue inside your transaction" no longer sets us apart. What does: the tables live in your schema and drizzle-kit, job types are typed, the claim is a single statement with leases (graphile-worker without Pro leaves crashed jobs locked for up to 4 hours), and there's an HTTP `runOnce` for serverless. Say so in the README, and document pg-boss as the next step for workflows or very high volume. Ideas worth copying:
   - graphile-worker's `jobKey` modes (`replace`, `preserve_run_at`) for debouncing;
   - pg-boss keeps expiry and heartbeat as separate settings;
   - OpenTelemetry-compatible span names (later).
2. **Rate limiting (6.1):** *adopted in Phase 1, except the response fields: there's no `reason` (the fallback mode is in `degraded`), `resetAt` stays a `Date` as in section 5, and the wait is `retryAfterMs`.* Lead with token bucket, typed rules, headers and the in-memory fallback. Phase 1 needs three decisions:
   - **time source:** Postgres `now()` avoids clock skew between app instances, but the fake-clock must-pass test needs the injected clock. Proposal: the SQL uses a timestamp parameter from the injected clock when one is given, and Postgres time otherwise;
   - **over-budget cost:** when `cost` is more than what's left, reject without consuming. @upstash/ratelimit 2.2 changed to this;
   - **response fields:** `reason` and `resetAt` in milliseconds, as upstash returns.
   
   RateLimit headers: the current draft is [draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) (`RateLimit` and `RateLimit-Policy` fields). Re-check it in Phase 1.
3. **API keys (6.3):** the planned `reason` enum is close to Unkey's verify codes, so keep it. Copy GitHub's approach for checksums and prefixes that secret scanners can recognize ([GitHub blog](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)). Also, **vante.app stores `HMAC(pepper, key)` with the raw pepper, but groundwork will use an HKDF subkey.** Existing vante keys won't verify after the Phase 7 migration unless Phase 3 adds a verify-only legacy hash option or the keys are re-issued. Decide in Phase 3.
4. **Idempotency (6.5):** the least crowded space, so feature it. Follow [draft-ietf-httpapi-idempotency-key-header-08](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/): 400 when a required key is missing, 422 for a different body, 409 while the first request is in flight.
5. **Audit (6.2):** drizzle-audit is the closest rival. Keep explicit, typed, in-transaction `record()` rather than ORM interception.
