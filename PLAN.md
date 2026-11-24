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
    next/           Next.js route helpers (no `next` import; see the Phase 5 log)
    testing/        fake clock, db reset, helpers for apps testing their own code
    internal/       durations ('15m', '90d'), HMAC/HKDF, CIDR matching, errors
  tests/
    unit/
    integration/    real Postgres via docker compose
  examples/
    next-app/       minimal Next.js app using every module
  docs/
```

Subpath exports: `groundwork`, `groundwork/schema`, `groundwork/rate-limit`, `groundwork/audit`, `groundwork/api-keys`, `groundwork/jobs`, `groundwork/idempotency`, `groundwork/next`, `groundwork/testing`. Each module also works standalone (`createRateLimiter({ db, table, secret })`). `createGroundwork` just wires them together. *Published as `@vantedev/groundwork` (decided 2026-11-20), so every subpath above is imported as `@vantedev/groundwork/…`.*

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

**Drivers:** accept any Drizzle `PgDatabase`. ~~The jobs module needs interactive transactions, so document that `neon-http` won't work for jobs (use the Neon websocket driver or a pooled TCP driver).~~ *Corrected in Phase 4: every groundwork statement is a single statement; only passing `{ tx }` needs a driver with transactions.*

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
- **Decided in Phase 2** (details in the Decisions log):
  - `record()` throws instead of swallowing errors;
  - `entityTypes` is optional and typed like `actions`;
  - redaction matches keys that contain a rule, on top of `DEFAULT_REDACT`;
  - `count()`, `search`, `where` and `order: "asc"` were added to cover the apps' read paths.
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
- **Decided in Phase 3** (details in the Decisions log):
  - the daily quota is a day-long window from the first request, as in vante.app;
  - `legacyHash` keeps vante.app's existing keys working and upgrades each on first use;
  - `gw.audit` accepts and types `api_key.*` actions automatically;
  - `update`, `reinstate` and `delete` are audited too;
  - `delete` (revoked keys only) and `redactKeys` were added for vante.app parity.
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
- **Decided in Phase 4** (details in the Decisions log):
  - a schedule tick runs as a job (`schedule:<name>`), so it gets retries, history and health, and overlapping ticks are skipped;
  - leases are renewed while a handler runs, and the attempt number fences out late results;
  - the worker uses only single statements, so no interactive transactions are needed;
  - `trigger(name)`, `list()` and per-schedule health were added for VaultDrop parity.
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
- **Decided in Phase 5** (details in the Decisions log):
  - it's `gw.idempotency.handle(request, { scope, ttl, required, fingerprint }, handler)`, with `withIdempotency(options, handler)` in `groundwork/next`;
  - the status codes follow the IETF draft (400/422/409), and only 2xx and 3xx responses are stored;
  - a running request holds its key with a renewed lease, so a crash frees it;
  - `run(input, fn)` covers anything that isn't an HTTP handler, and storing less than the full response.
- **Must-pass tests:**
  - concurrent duplicates: the handler runs once;
  - replay returns the same status and body;
  - the TTL expires.

### 6.6 `groundwork/next`

- `withApiKey(scopes, handler)`, `withRateLimit(rule, keyFn, handler)`, `jobsRoute(gw, { secret, budgetMs })` and `withIdempotency`.
- `getClientIp(headers, { trustProxy })`. Proxy headers are untrusted by default. Presets: `vercel`, `cloudflare` (`cf-connecting-ip`), `x-forwarded-for` with a hop count.
- Read the installed Next.js docs before writing this. Next 16 has breaking changes.
- **Decided in Phase 5:** the wrappers come from `createRouteHelpers(gw, { trustProxy })`, so they're bound to one instance and one proxy setup, with the signatures above. `jobsRoute` and `getClientIp` are standalone. Nothing imports `next` or `server-only`.

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
- [x] `record`, `recordMany`, `diff`, redaction, `query`, `prune`, typed actions
- [x] All 6.2 must-pass tests
- **Done when:** vante.app's and bubblehouse-dk's audit needs are covered.

### Phase 3: Scoped API keys
- [x] Full lifecycle, `verify`, CIDR, per-key limit and quota through Phase 1, the audit hook through Phase 2
- [x] All 6.3 must-pass tests
- **Done when:** everything vante.app's `src/features/api-keys` does is possible, except country checks (out of scope).

### Phase 4: Background jobs
- [x] `define`/`enqueue` (in transactions), batch claim, leases, backoff, timeouts, `runOnce`, `work`, schedules, `health`, ops
- [x] All 6.4 must-pass tests, including the multi-worker race test
- **Done when:** vante.app's `worker.ts` + `features/jobs` and VaultDrop's runner can both be replaced.

### Phase 5: Idempotency + Next.js helpers + example
- [x] 6.5 and 6.6
- [x] `examples/next-app` uses every module end to end and runs in CI
- **Done when:** the README quickstart works copy-pasted into a fresh Next.js app.

### Phase 6: Docs + 0.1 release
- [x] README in the same style as my other repos (banner, badges, quickstart, a short section per module, a comparison table with honest trade-offs)
- [x] `docs/` with one page per module, plus migration notes for moving from hand-rolled tables
- [x] Publish `0.1.0` with provenance *(published 2026-11-20 as `@vantedev/groundwork`, by hand and so without provenance; later releases get provenance through trusted publishing)*

### Phase 7: Dogfooding, then 1.0
- [x] Faultline: swap the in-memory limiter (this fixes the multi-instance problem). *Merged 2026-11-20.*
- [x] vante.app: rate limiting, audit, API keys, jobs. *Merged 2026-11-20.*
- [x] VaultDrop: rate limiting, jobs, idempotency. *Merged 2026-11-20.*
- [x] bubblehouse-dk: audit, mail outbox through jobs. *Decided 2026-11-23: neither moves; bubblehouse-dk keeps both. It uses groundwork's rate limiting instead (see the log).*
- [x] For each app, record the lines removed and any API pain it exposed, and fix that pain in groundwork, not in the app. *Recorded below; fixed in 0.2.0 (released 2026-11-23). Hookline's web API got rate limiting too.*
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

- **Name and npm scope:** `groundwork` is a working name. Check npm and GitHub before Phase 6. **Decided 2026-11-20: `@vantedev/groundwork`** (`groundwork` is taken on npm, and the `vante` org couldn't be created), in the public repository `kaanxsrd/groundwork`.
- **License:** MIT recommended. My apps use GPL-3.0, but GPL on a *library* stops many companies from using it. **Decided 2026-11-19: MIT.**
- **Redis adapter for rate limiting** in v1 or later? Hookline uses Redis today. **Decided 2026-11-19: in v1.**
- **Minimum Postgres version.** **Decided 2026-11-19: 16. CI tests 16 and 18.**
- **Default table prefix:** `gw_`, or plain names (`rate_limits`) that might clash with tables the apps already have? **Decided 2026-11-19: `gw_`.**
- **Faultline and PostgreSQL 15.** Faultline's docs promised PG15+, but groundwork's minimum is 16. **Decided 2026-11-23: Faultline requires 16.** Its images already ran 17; only its docs changed.
- **Drizzle 1.0.** It's at `1.0.0-rc.6`. groundwork's runtime works on it since the 2026-11-24 fix, but the table types are tied to the Drizzle major groundwork is built against (see the log). Choose: drop 0.45 for 1.0 in a 0.x minor once Drizzle 1.0 is out, and make that the line groundwork 1.0 freezes; widen the peer to `^0.45.0 || ^1.0.0` now, with tables typed for 0.45 only; or ship groundwork 1.0 on 0.45 and move to Drizzle 1.0 in 2.0. **Open.**
- **bubblehouse-dk's audit log and mail outbox.** **Decided 2026-11-23: both stay bubblehouse-dk's own.** The outbox works and sends a live shop's payment mail. The audit log would need renamed columns at six readers, new ids and an import that duplicates on re-runs, for no new capability. 0.3.0's retry ladder would cover the outbox's retry schedule if it ever moves.

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
- 2026-11-19 (Phase 2): The owner replied "continue" to the Phase 1 report, which I took as approval of Phase 1. The open questions (daily quotas, legacy key hashes, Drizzle 1.0, `PROMPT.md`, a GitHub repo) don't affect Phase 2 and are still open.
- 2026-11-19: `gw_audit_log` columns: `id`, `occurred_at`, `actor_type`, `actor_id`, `actor_label`, `action`, `entity_type`, `entity_id`, `summary`, `changes`, `metadata`, `ip`, `request_id`.
  - `id` is a `bigint GENERATED ALWAYS AS IDENTITY` (Drizzle mode `number`), so nothing can supply ids.
  - Both reference tables are covered: vante.app's `actor`/`summary`/`metadata`/`ip`, and bubblehouse-dk's `actor_id`/`actor_role`/`description`/`changes`. Its role becomes `actor_label`, and a null actor becomes `actor_type: "system"`. `docs/audit.md` has a migration SQL snippet for each.
  - Indexes: `(occurred_at, id)`, plus action, entity and actor, each followed by `(occurred_at, id)`, so filtered pages never sort.
- 2026-11-19: `occurred_at` defaults to `now()`, the transaction's start time, not `clock_timestamp()`. An entry recorded with a change then carries the same timestamp as that change, matching Drizzle's `defaultNow()` on app tables. Explicit `occurredAt` (for imports) and an injected clock override it.
- 2026-11-19: `record()` throws on invalid events (`invalid_argument`, before anything is sent) and on database errors. Both reference apps swallow and log audit errors, but inside a transaction a swallowed error has already aborted the transaction, so the business commit fails later with a confusing message. The docs show the one-line catch for best-effort logging.
- 2026-11-19: Actions are required and inferred through `const` type parameters, so there's no `as const`, and they're also checked at runtime. `entityTypes` is optional and typed the same way, because bubblehouse-dk types its entity types; it's an addition to the plan's sketch. `createGroundwork({ audit: { actions } })` carries both types through to `gw.audit`.
- 2026-11-19: Redaction rules:
  - A string matches any key that *contains* it, ignoring case, `_` and `-`, so the sketch's `redact: ["token"]` also covers `accessToken`/`refresh_token`. A RegExp is tested against the raw key.
  - `DEFAULT_REDACT` (password, passwd, secret, token, apiKey, authorization, cookie, privateKey) always applies unless `redactDefaults: false`. Secure by default, with over-matching (`tokenCount`) as the safer failure.
  - Redaction and JSON normalisation happen in one walk: Dates become ISO strings, bigints strings, `undefined` and functions are dropped, Maps and Sets become objects and arrays, cycles become `"[circular]"`, and depth is capped at 32. The input is never mutated.
  - `summary`, `actor.label` and `ip` are not redacted, which the docs say.
- 2026-11-19: `query()` uses keyset pagination on `(occurred_at, id)` with an opaque cursor. The cursor carries `occurred_at` as microsecond ISO text, because a JS Date's milliseconds would skip or repeat entries that share a millisecond, and it records the order. JSON and timestamps are selected as text, so both drivers return the same thing.
- 2026-11-19: Bug found by the must-pass pagination test: `ORDER BY id` resolved to the `id::text` output alias (Postgres prefers output names in ORDER BY), so ties sorted as text while the cursor compared numbers, and concurrent pages returned duplicates. ORDER BY now uses the qualified table columns. Mutation check: dropping the id tie-breaker from the cursor makes the same test report 281 missing entries.
- 2026-11-19: The pagination guarantee as documented: no entry appears twice, and every entry committed before the walk started appears exactly once. Entries committed during the walk may or may not appear: a long transaction that commits after the walk passed its timestamp isn't seen. That's inherent to any timestamp-ordered log, short of commit-timestamp tracking.
- 2026-11-19: `count()` and the `search`/`where` filters go beyond the plan. They cover what the apps use today: bubblehouse-dk's totals and free-text search, and its order timeline, which needs `changes->>'orderNumber'`. Both apps paginate with page numbers and offsets; groundwork offers cursors plus `count()`, which means newer/older navigation instead of page jumping. Offsets could be added later if dogfooding needs them.
- 2026-11-19: `recordMany` is capped at 1,000 events per call, because 12 parameters per row stay far below Postgres's limit of 65,535, and it's one statement so it's all-or-none without a transaction. `prune` deletes in batches of 5,000 ordered by `(occurred_at, id)`.
- 2026-11-19: The table-shape check is shared (`internal/table.ts`) by the rate-limit and audit modules. The smoke test now records, redacts and queries an audit entry through the packed package on Node, and type-checks typed actions on TS 5.9, 6.0 and 7.0. The fixtures gained `auditLog` and `altAuditLog` through an incremental migration (`0001_audit_log`), the way an app would adopt a new module.
- 2026-11-19 (Phase 3): The owner replied "continue" to the Phase 2 report, which I took as approval, including the proposal that `gw.audit` accepts groundwork's `api_key.*` actions. The two open Phase 3 questions were settled by what vante.app does today, because the done criterion is vante.app parity:
  - the daily quota is a day-long window starting at a key's first request, not calendar-aligned;
  - existing keys keep working through `legacyHash`.
  
  Still open: page numbers for the audit UI, Drizzle 1.0, `PROMPT.md`, and a GitHub repo.
- 2026-11-19: Key format: `<ns>_<12 hex>_<43 base64url>` (vante.app's), plus a 6-character base62 CRC32 suffix, as GitHub's tokens have.
  - The HMAC covers the key without the suffix, so keys with and without a checksum verify alike and vante.app's keys parse unchanged.
  - Parsing uses fixed-length checks only, so there's no regex backtracking.
  - CRC32 is implemented in-house, because `zlib.crc32` needs Node 22.2 and engines say `>=22`. A test compares it with zlib, and another proves every single-character substitution of a real key is rejected (about 33k cases).
- 2026-11-19: `gw_api_keys` columns:
  - **From vante.app:** prefix, key hash, previous hash and expiry, scopes, rate limit, daily quota, origins, IPs, expiry, revocation, suspension, rotation, last use, `created_by`.
  - **Added:** `owner_id` (the plan's `ownerId`) and `metadata` (vante.app's country list goes here, since country checks are out of scope).
  - **Changed:** `rate_limit_window` is a duration string instead of vante.app's fixed per-minute column.
  - **Indexes:** unique on `key_hash` and `prefix`, partial on `previous_key_hash`, and `(owner_id, created_at)`.
- 2026-11-19: Every query returns the record as one `jsonb_build_object(...)` text column, so one parser serves create, get, list, update and verify, and both drivers return identical shapes. `text[]` parameters travel as JSON (`jsonb_array_elements_text` with ordinality), because Drizzle's `sql` expands JS arrays into `($1, $2)` lists. `update` reads the old row and writes the new one in one statement (a `for update` CTE plus `update`), so the audit diff is exact without needing PG 18's `RETURNING OLD`.
- 2026-11-19: `verify` checks in vante.app's order:
  1. parse (no DB);
  2. one lookup that matches the current hash, the previous hash within its grace period, or the legacy hash;
  3. timing-safe confirmation of which hash matched;
  4. revoked, expired, suspended;
  5. IP, then origin, before scopes, so a request from the wrong network learns nothing about scopes;
  6. per-key rate limit, then quota, only after everything else passed.
  
  A key with a rate limit and a quota costs 3 round trips. Folding them into the lookup's statement is a possible optimisation; it isn't done because it would couple the API-key SQL to the Postgres rate-limit store (and rule out Redis).
- 2026-11-19: Statuses follow vante.app: missing, malformed, invalid, revoked and expired are 401; suspended, ip_denied, origin_denied and forbidden_scope are 403; rate_limited and quota_exceeded are 429. Bodies are `{ error: { code, message, missingScopes? } }`, with RFC 6750 `WWW-Authenticate` (`invalid_token`, `insufficient_scope` with `scope="…"`), `Cache-Control: no-store`, and rate-limit headers on 429s. vante.app's error codes (`missing_api_key`, …) become the plan's reasons; its `X-RateLimit-*` headers become draft-11 headers, which dogfooding has to account for.
- 2026-11-19: Origin checks follow vante.app: a request without `Origin` isn't held to the allowlist, because only browsers send it and anything else can forge it. Origins are canonical (`URL.origin`: lower case, default port dropped). The literal `null` origin is denied.
- 2026-11-19: IP allowlists are CIDR (vante.app only matches exact addresses; its stored values stay valid).
  - Everything is compared as 128 bits, with IPv4 mapped into `::ffff:0:0/96`, so IPv4 rules match the IPv4-mapped form Node reports.
  - Strict parsing: no octal-looking octets, and host bits set (`10.0.0.1/8`) is rejected with a "did you mean" hint. Zone ids are stripped; text is canonical RFC 5952.
  - Stored entries that fail to parse are skipped, which fails closed. 61 edge-case unit tests.
- 2026-11-19: Per-key limits run through `gw.rateLimit`, with one rule name per kind (`<ns>:key`, `<ns>:key.daily`) and the key id as subject, so changing a key's limit keeps its counter.
  - The default is 60 per minute (vante.app's). If no rate limiter is available, startup fails unless `defaultRateLimit: null`, so a key is never silently unlimited.
  - Setting a limit or quota without a limiter is an `invalid_argument`.
- 2026-11-19: `lastUsedAt`/`lastUsedIp` are updated only after a successful verify, at most once a minute per key.
  - Two guards: an in-memory map per instance, and a SQL condition on `last_used_at`. A second instance reads the fresh timestamp and skips, as a test shows.
  - The write runs in the background through an optional `waitUntil` (Next.js `after`, `ctx.waitUntil`), and failures are logged once. vante.app wrote it on every successful request.
- 2026-11-19: `legacyHash(key)` returns the old system's stored hash. Lookup uses `key_hash in (new, legacy)` in the same single query. A legacy match is upgraded to groundwork's hash in the background, so the old pepper can be retired once every key has been used. `docs/api-keys.md` has the copy-over SQL for vante.app.
- 2026-11-19: Audit events cover create, update, rotate, revoke, suspend, reinstate and delete (vante.app audits all of them; the plan named four). They are written through `onEvent` in the mutation's `tx`, so a rolled-back revoke leaves neither the revocation nor its entry. Without a `tx` the two are separate statements, which the docs say. Entries name the key and its prefix, never the key; update entries carry a diff of the policy fields.
- 2026-11-19: Lifecycle details: `rotate` returns `null` for revoked keys. Rotating during a grace period ends the older key (vante.app does the same). `delete` only deletes revoked keys. `reinstate` and `suspend` skip revoked keys. Invalid UUIDs return `null`/`false` instead of a SQL error. `expiresAt` must be in the future.
- 2026-11-19: Mutation checks:
  - removing the grace expiry (SQL and JS) fails the rotation test;
  - disabling the IP check fails the CIDR test;
  - a typo'd key in the "never hits the DB" test proves the checksum works.
  
  A first-run flake (two keys created at the same fake-clock instant tie-broke `list()` order by random UUID) was a test issue, fixed by advancing the clock. 5× reruns on both drivers: 125/125.
- 2026-11-19: Failure results carry `prefix`, the presented key's display prefix, whenever it parsed (so for invalid keys too). vante.app logs it for failed attempts, and only having `key` (set when the record is found) would have lost that.
- 2026-11-19 (Phase 4): The owner replied "continue" to the Phase 3 report, which I took as approval of Phase 3 and of both recommendations:
  - API-key verify keeps up to 3 round trips;
  - jobs are positioned as simple typed jobs in your schema, with pg-boss and graphile-worker documented as the next step.
- 2026-11-19: `gw_jobs` follows vante.app's `jobs` columns (uuid id, type, jsonb payload, status, attempts, max_attempts default 5, run_at, last_error, created_at, completed_at).
  - **Added:** priority, a lease (`locked_until`, `locked_by`), `dedupe_key`, a jsonb `result` (VaultDrop's run stats), `started_at`, `updated_at`.
  - **Status:** checked `text`, because a Postgres enum would need its own export for drizzle-kit (the `pgSchema` trap again).
  - `gw_job_schedules` holds name, every, `next_run_at`, and last run/success/failure/error.
- 2026-11-19: Claiming:
  - One statement, `UPDATE … FROM (SELECT … FOR UPDATE OF c SKIP LOCKED LIMIT n)`, which claims up to the free concurrency at once (vante.app claims one at a time).
  - A claim sets `run_at` to the lease expiry, so "due" and "dead worker" are one condition, `status in (pending, running) and run_at <= now`, served by one partial index on `(priority desc, run_at, id)`. `EXPLAIN` showed adding `id` turns a bitmap scan plus sort into an ordered index scan that stops at `LIMIT` (cost 384 → 1.6 on 20k rows).
  - Workers only claim types they've defined, so rolling deploys and mixed apps don't steal jobs.
- 2026-11-19: Leases replace vante.app's fixed 5-minute stale-lock rule.
  - The lease defaults to `"1m"` and is renewed every lease/3 while the handler runs, so long jobs keep their lease and dead workers lose theirs within a minute.
  - Fencing: complete, fail and renew all require `locked_by` plus the claimed `attempts`. A late result from a worker that lost its lease is dropped and logged, and if renewal finds the lease gone the handler's signal aborts.
  - A reclaim that pushes `attempts` past `max_attempts` fails the job without running it, because the dead worker's attempt counts.
  - Mutation checks: removing `FOR UPDATE … SKIP LOCKED` fails the 8×500 race test, and removing fencing fails the killed-worker test.
- 2026-11-19: Retries use capped exponential backoff with full jitter, `random(0, min(max, base × 2^(attempt−1)))`. Job defaults are `base "30s"` (vante.app's base) and `max "1h"`; schedule defaults are 3 attempts with `base "5s"`, `max "1m"`, as in VaultDrop. Timeouts default to `"5m"` and abort `context.signal`. A handler that ignores the signal keeps running, but its outcome no longer counts.
- 2026-11-19: Payloads are validated with Standard Schema (types copied into `internal/`, as the spec allows), on enqueue and again before running.
  - A stored payload that fails validation fails at once without retrying.
  - Payload types come from the schema's input/output, or from `run`'s annotated parameter, through two `define` overloads.
  - Payloads are stored as JSON (Dates become strings, which the docs call out).
  - zod is a devDependency for tests only.
- 2026-11-19: Schedules (`schedule(name, { every }, fn)`) run as jobs of type `schedule:<name>`, rather than inline as in VaultDrop.
  - One statement both claims the tick, by moving `next_run_at` forward conditionally (exactly one instance wins), and enqueues the job with dedupe key `tick`, so a tick is skipped while the previous one is pending or running.
  - Ticks get retries, timeouts, `result` (VaultDrop's stats), history and health for free. Completion and failure update the schedule's last success/failure/error in the same statement.
  - New schedules are due at once; after that, `next = now + every`. There's no cron syntax, as planned.
  - `trigger(name)` makes a schedule due now (VaultDrop's `?job=<name>`). `health().schedules[].healthy` follows VaultDrop's rule: a success within 3 intervals.
- 2026-11-19: `runOnce({ budgetMs, concurrency })` stops claiming once the budget is spent and waits for running jobs. It keeps going while jobs finish, in case they enqueue follow-ups. `work()` waits `pollInterval` when idle (woken early when a job finishes). On abort it stops claiming and resolves after running jobs finish; it logs database outages once and retries. LISTEN/NOTIFY is still a later feature.
- 2026-11-19: `createGroundwork` registers `groundwork.rate-limit-cleanup` (hourly) when rate limiting is configured, as §6.1 asked; `jobs: { rateLimitCleanup: false }` turns it off. Job pruning is left to the app, and the docs show a one-line schedule for it.
- 2026-11-19: The plan said jobs need interactive transactions and so can't run on neon-http. The worker uses only single statements, so that limit no longer holds; I corrected the README's requirements line. Only `postgres` and `pg` are tested.
- 2026-11-19: Not done:
  - **Permanent dedupe.** bubblehouse-dk's outbox needs "once ever" for `(order, kind)`, while `dedupeKey` is active-only, as the plan says. It's flagged for Phase 7, and the docs suggest keeping that state in the app's own table.
  - Batch `enqueueMany`.
  - Job dependencies and LISTEN/NOTIFY.
- 2026-11-19: Test-setup issues found and fixed:
  - jobs enqueued without the workers' fake clock were in the "future" for them;
  - advancing a fake clock by a full lease correctly expired a running tick's lease.
  
  Neither was a library bug.
- 2026-11-19 (Phase 5): The owner replied "continue" to the Phase 4 report, which I took as approval of Phase 4 and of both recommendations:
  - **`next` and `server-only`:** neither is a dependency. `groundwork/next` turned out not to need `next` at all, so `drizzle-orm` stays the only peer. Route handlers take a Web `Request` and `{ params: Promise<…> }`, and Next's generated route validator accepts any function of that shape. `server-only` isn't needed: groundwork imports `node:crypto`, so a client bundle fails anyway.
  - **bubblehouse-dk's once-ever outbox** keeps that state in its own table; no new jobs API.
- 2026-11-19: Before starting, a stray edit (`rowsOf(  n`) in `src/jobs/jobs.ts` after the Phase 4 commit broke the build. The owner chose to revert it, so the file is back to the committed version.
- 2026-11-19: `gw_idempotency_keys` follows VaultDrop's `idempotency_keys` (scope, key, request hash, stored response, created).
  - **Hashed:** the primary key is HMAC(subkey, [`http`|`run`, scope, client key]), so raw keys are never stored and `run()` keys never collide with HTTP ones. The fingerprint is a keyed HMAC too, because an unkeyed hash of a small JSON body can be guessed. The subkey is the `idempotency` purpose reserved in Phase 0.
  - **Leases:** `locked_by` and `locked_until`, renewed every lease/3 (default lease `"30s"`). This fixes VaultDrop's weak spot: there, a crashed request leaves its key "in progress" for 24 hours. Completing or releasing requires `locked_by`, so a late finisher can't overwrite a retry's result.
  - **`response` is `text` holding JSON**, not `jsonb`: jsonb rejects `\u0000`, which a stored body may contain.
  - `expires_at` is set at the start and again on completion (`ttl` from completion, default `"24h"`, like Stripe and VaultDrop). An expired row, or an abandoned one whose lease ran out, means the same as no row.
- 2026-11-19: Claiming is one statement: `INSERT … ON CONFLICT DO UPDATE … WHERE` (expired, or abandoned with the same fingerprint), plus a fallback select of the existing row. A row committed after the statement's snapshot is invisible to that select, so an empty result is retried with a fresh snapshot up to 3 times. After that it's treated as in progress, the safe answer. This is the same pattern as job enqueue. Fingerprints are compared with `timingSafeEqual`.
- 2026-11-19: HTTP behaviour follows draft-ietf-httpapi-idempotency-key-header-08:
  - 400 `idempotency_key_missing` (only with `required: true`; the default runs the handler unprotected, as VaultDrop does);
  - 400 `idempotency_key_invalid`;
  - 422 `idempotency_key_reused`;
  - 409 `idempotency_key_in_use`, with `Retry-After: 1`.

  The error body is groundwork's usual `{ error: { code, message } }`, not problem+json; the draft only shows problem+json as an example. Keys are 8–255 visible ASCII characters, sent bare (Stripe, VaultDrop) or as the draft's sf-string. The default fingerprint is method + path with query + body bytes, read from `request.clone()` so the handler can still read the body. `fingerprint` overrides it once the body has been read.
- 2026-11-19: Only 2xx and 3xx responses are stored. A 4xx, 5xx or throw releases the key, as VaultDrop does on a throw. Storing a 429 or 409 would replay a transient error for a day, and a failed request is by convention one that did nothing. Stripe also stores 5xx; groundwork doesn't, and documents that handlers should be transactional.
  - Never stored: `Set-Cookie` (credentials), per-request headers (`RateLimit*`, `Retry-After`, `Date`, `Content-Length`, hop-by-hop).
  - Bodies are stored as UTF-8 text when valid, else base64. Replays get `Idempotent-Replayed: true`, the header name Stripe and VaultDrop use.
  - The first response is rebuilt from the bytes that were stored, so the first call and a replay are byte-identical.
- 2026-11-19: `run({ scope, key, fingerprint, ttl }, fn)` was added beyond the plan. VaultDrop's route stores only `{ id, expiresAt }` and derives the receipt token (a credential) on every replay, which `handle()` alone couldn't express. It's also the natural API for webhook events.
  - It returns `{ ok, value, replayed }` or `{ ok: false, reason: "mismatch" | "in_progress" }`.
  - The value is the JSON round trip on the first call too, so it never differs between calls, and its type is `Jsonify<T>`: `Date` becomes `string`, and functions and `undefined` properties drop out or become optional. The type is checked on TS 5.9, 6.0 and 7.0.
- 2026-11-19: `createGroundwork` gets `tables.idempotencyKeys`, `idempotency: { ttl, lease }` and `gw.idempotency`. `gw.jobs` also schedules `groundwork.idempotency-cleanup` hourly; `jobs: { idempotencyCleanup: false }` turns it off.
- 2026-11-19: The `groundwork/next` signatures are as the plan wrote them, but bound to one instance: `createRouteHelpers(gw, { trustProxy })` returns `withApiKey(scopes, handler)`, `withRateLimit(rule, key, handler)`, `withIdempotency(options, handler)` and `clientIp(request)`. `withApiKey(scopes, handler)` has nowhere else to get `gw` from. The factory also gives one place for `trustProxy`, which `withApiKey` needs for IP allowlists.
  - Handlers get Next's `(request, context)`, and wrappers add to the context: `context.apiKey`.
  - Plain nested generic wrappers don't infer what an outer wrapper adds. I tested the shapes in a scratch project: a non-generic first overload of `withApiKey` makes nested `withRateLimit` and `withIdempotency` infer `apiKey`, and a second generic overload takes `withApiKey<RouteContext<"/posts/[id]">>` for typed params.
  - `withRateLimit`'s key function may return `null` to skip limiting.
- 2026-11-19: `jobsRoute(gw, { secret, budgetMs, concurrency })` answers GET and POST (Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`).
  - The secret must be at least 16 characters with no whitespace, checked at startup. Tokens are compared as HMAC digests, so the time doesn't depend on length either.
  - `?schedule=<name>` calls `trigger(name)` first, as VaultDrop's `?job=` does (404 if unknown). The response is the `RunSummary`.
- 2026-11-19: `getClientIp(input, { trustProxy })`:
  - **Presets:** `"none"` (the default) reads nothing; `"vercel"` reads `X-Real-IP`; `"cloudflare"` reads `CF-Connecting-IP`; `{ header, hops }` takes the entry `hops` from the right.
  - **Why `"none"`:** Next's `next start` sets `X-Forwarded-For` only when the client didn't send one (`??=` in base-server.js), so on a bare server every header is spoofable.
  - **Vercel:** its docs say it overwrites `X-Forwarded-For`, and that `X-Real-IP` is identical.
  - Ports and brackets are stripped, and addresses are canonicalised with the CIDR module's parser (now exported internally as `canonicalIp`). Bad `trustProxy` values throw at startup.
  - vante.app's IPv6 /64 bucketing for rate limits isn't done; it's for Phase 7.
- 2026-11-19: Next.js 16.4.6's `create-next-app` turns on `cacheComponents` by default. With it, a GET handler that reads nothing from the request is prerendered at build. Next tracks `request.headers` access as dynamic (`proxyNextRequest`), so every groundwork wrapper and `jobsRoute` run at request time. The docs say to call `await connection()` in other GET routes, as the example's health route does.
- 2026-11-19: `examples/next-app` is the app `create-next-app` 16.4.6 generates (Cache Components on), plus every module:
  - admin-only key creation;
  - posts with a per-key write limit, idempotency, an audit entry and a job enqueued in the same transaction;
  - a daily retention schedule, the cron route, the audit log and queue health.

  Its migrations are generated by its own drizzle-kit and committed. It depends on `groundwork@^0.1.0`, so `npm install` works there once 0.1 is published; until then, `node scripts/example.mjs dev` runs it from the checkout. Vercel Hobby fails a deploy whose cron runs more than once a day (Vercel's cron docs), so its `vercel.json` runs `/api/jobs` daily.
- 2026-11-19: `scripts/example.mjs` (`bun run example`, a new CI job) installs the packed tarball into two apps outside the repo, which keeps Turbopack's root and drizzle-orm to one copy each. It builds each with `next build`, starts it with `next start` and drives it over HTTP:
  - **examples/next-app:** every module, with migration drift checked;
  - **the README quickstart:** a fresh `create-next-app` project, with the README's `filename="…"` blocks and its `npm install` / `npx drizzle-kit` lines run as written (groundwork swapped for the tarball). That is the Phase 5 "done when", checked on every push. `next build` type-checks the quickstart's code, which Biome doesn't see (Markdown is excluded).
- 2026-11-20: Run under `npx -p node@22`, npm leaves `npm_config_package=node@22` in the environment, and the script's own `npx create-next-app@…` then ran inside that package instead. `scripts/example.mjs` drops the variable for everything it starts. CI uses `setup-node`, so only local runs hit this.
- 2026-11-19: Root dev tooling:
  - I briefly added `next` and `react` as root devDependencies to read Next's docs. With `react` there, Biome 2 switched on its React rules and called `useTestDatabase()` a hook, so they live only in the example now.
  - Biome's example override allows default exports and extensionless imports (Next's conventions), and generated example migrations are excluded. An early `biome check --write` had rewritten the example's imports to `.ts`; I reverted that once the override was in.
- 2026-11-19: Mutation checks, each caught and restored byte-for-byte:
  - a takeover of live keys fails 16 tests, including all three concurrency must-pass tests;
  - no fingerprint check fails 5 tests;
  - no expiry fails the TTL must-pass test;
  - no lease heartbeat fails the lease-renewal test;
  - no fencing on completion fails the crash-recovery test.
- 2026-11-19: Not done:
  - a `{ tx }` option to store the result inside the handler's own transaction, which would close the "crashed after commit, before storing" gap (documented);
  - problem+json error bodies;
  - waiting for an in-flight duplicate instead of answering 409;
  - IPv6 /64 bucketing.
- 2026-11-20 (Phase 6): The owner replied "continue" to the Phase 5 report, which I took as approval of Phase 5.
- 2026-11-20: Two Phase 6 decisions, asked and answered:
  - **Name:** `groundwork` is taken on npm by an unrelated scaffolding tool (0.2.1, last changed 2023). The package is now **`@vante/groundwork`**, matching `author: "Vante"`. Every import is `@vante/groundwork/<subpath>`; the product is still called groundwork. The unscoped `groundwork-pg` and `drizzle-groundwork` were the alternatives (the second reads like an official Drizzle package).
  - **Repository:** the owner approved creating **public** `kaanxsrd/groundwork`, where the five sibling apps live, and pushing `main`. npm provenance needs a public repository. The first GitHub Actions run passed all 7 jobs on Linux, including the Next.js example and README quickstart.
- 2026-11-20: §9 had asked to check the name before Phase 6, and I should have raised it in an earlier report; it came up when Phase 5 ended.
- 2026-11-20: The rename is a scripted, reviewed replacement of import specifiers, install commands, changeset front matter and backticked import paths. It leaves the Docker database URLs (`postgres://groundwork:groundwork@…`) and the product name alone. `package.json` gained `repository` (provenance checks it against the publishing repo), `homepage`, `bugs` and `publishConfig.access: "public"` (scoped packages are private otherwise); a unit test pins them. `scripts/example.mjs` and the smoke test read the name from `package.json`, so a future rename is one line.
- 2026-11-20: A literal NUL byte had been committed in `docs/schema.md` in Phase 5, where a Python edit turned the text `\u0000` into the character. Git showed the file as binary. Fixed, and every tracked file was scanned: it was the only one.
- 2026-11-20: Releases follow VaultDrop's CLI process (`docs/publishing-cli.md` there), adapted for Changesets:
  - `bun x changeset version`, commit, tag `vX.Y.Z`.
  - `.github/workflows/release.yml` runs in a protected `npm` environment. It checks that the tag matches the version, that no changesets are left, and that `repository` and `access` are set. Then it runs Biome, tsc, the full suite against Postgres and Redis, and the smoke test, and publishes with `npm publish --provenance --access public`.
  - npm only connects trusted publishing to a package that exists, so the first release uses an `NPM_TOKEN` environment secret once. Published from the workflow, 0.1.0 still gets provenance. The token is then replaced by trusted publishing and tokens are disallowed. [docs/releasing.md](docs/releasing.md) has every step, including a manual fallback without provenance.
- 2026-11-20: `bun x changeset version` turned the seven changesets (Phases 0–5 and the rename) into 0.1.0 and `CHANGELOG.md`. Publishing is the one step left. It needs the owner to create the `vante` npm organization and the token, and to approve pushing the release commit and the `v0.1.0` tag. Nothing has been published.
- 2026-11-20: The README follows VaultDrop's and Hookline's layout:
  - light and dark banners (hand-written SVG, rendered and checked), badges including CI and npm, and a links row;
  - "Why", a two-column "What's inside" grid, the CI-tested quickstart (kept byte for byte), a short section per module with code, and "Compared with", which says for each module when another tool fits better;
  - requirements, a documentation table, and a footer.
  
  It no longer says "one round trip on hot paths". A rate-limit check is one, but key verification can take up to three (the Phase 3 decision).
- 2026-11-20: New docs:
  - `docs/migrating.md`: the side-by-side approach, what to do with each module's old data (with links to the per-module SQL), an atomic move of vante.app's pending jobs, and an order per app;
  - `docs/testing.md`: real Postgres, `createTestClock` (and the shared-clock pitfall found in Phase 4), `runOnce()` in tests, calling route handlers directly, and asserting the logger stayed quiet;
  - `docs/releasing.md`.
  
  The example's README now describes installing from npm, with `node scripts/example.mjs dev` for running it against the checkout.
- 2026-11-20: The npm org `vante` couldn't be created, so the package is **`@vantedev/groundwork`**, under the owner's npm user `vantedev`, which also publishes `vaultdrop` and `hookline-cli`. A user scope needs no organization. 0.1.0 was never published, so the rename breaks nothing; this supersedes `@vante/groundwork` above.
- 2026-11-20: The first release is published by hand from a clean checkout, as VaultDrop's CLI was, so 0.1.0 has no provenance; trusted publishing gives every later release provenance. The release workflow now skips publishing when the tagged version is already on npm, so tagging `v0.1.0` afterwards only runs the checks.
- 2026-11-20: At the owner's request, every commit message was rewritten to Conventional Commits, without "Phase" wording or co-author trailers. The GitHub repository was then deleted and recreated, so its cached contributor list starts fresh. Claude Code files (`.claude/`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `PROMPT.md`) are ignored by git.
- 2026-11-20: Published `@vantedev/groundwork@0.1.0` by hand, confirmed with 2FA in the browser. Its shasum (`7b638162…`) matches the tarball built and dry-run from `180427c`, and installing it from npm into an empty project loads all 9 subpaths on Node 22. While npm processed the new package, it showed a placeholder version `0.0.0-stage` ("Temporary package placeholder for staged publishing"); `latest` then moved to 0.1.0. `v0.1.0` is tagged on `180427c`.
- 2026-11-20: The release workflow's run for `v0.1.0` failed in the smoke test before the (skipped) publish step: `npm@latest` is now npm 12, whose `npm pack --json` prints an object keyed by package name instead of an array. The smoke and example scripts now read both shapes (tested under npm 12 and Node 22's npm), and the workflow pins `npm@11`, which still has trusted publishing. The `v0.1.0` run stays red; the tag isn't moved.
- 2026-11-20 (Phase 7): groundwork runs in all five apps, each on a `feat/groundwork` branch. Nothing is merged or pushed, and old tables are kept until a later migration drops them. Lines are app code without tests, migrations, docs or lockfiles (added/removed):
  - **Faultline** (+60/−30): its in-memory `Map` limiter is now `gw.rateLimit` in Postgres, so limits hold across instances. A separate commit moves Next.js to 16.4.6: `next build` refuses 16.4.3, which has advisories.
  - **vante.app** (+551/−561): rate limiting, API keys (moved with `legacyHash`, so no key is re-issued), audit and jobs, with data migrations for keys, audit entries and pending jobs, each tested.
  - **VaultDrop** (+307/−260): rate limiting (Redis optional), idempotency through `run()` and its four jobs as schedules. Also fixed the admin page's rate-limit panel, which still read the old table. Checked in a production build: the worker runs every schedule, and the cron route answers as before. A separate commit moves Next.js to 16.4.6.
  - **bubblehouse-dk** (+67/−31): `rateLimit()` keeps its nine callers and the password-reset limit. Checked in a production build: 429 after 120 requests.
  - **Hookline** (+43/−38): the REST API's Redis token bucket is groundwork's token-bucket rule on `redisStore`. If Redis is down it now keeps counting in memory instead of failing open. The Go edge and worker read `api_key` and `idempotency_key` themselves, so those stay Hookline's.

  The mechanism code went away (the limiter SQL and Lua, the queue's claim and retry logic, idempotency's state machine). Glue kept the totals flat: lazy instances, pino adapters, wrappers that keep each app's signatures, and rule caches. 0.2.0 removes most of that glue.
- 2026-11-20: API pain found while dogfooding, and what 0.2.0 does about it:
  - **The secret was needed at construction.** Four apps wrapped groundwork in a lazy getter (it isn't set during `next build`), and Faultline's worker, which has no secret, skipped rate-limit cleanup. Fixed: `secret` can be a function, called once on first use.
  - **verify only returned headers.** vante.app keeps `X-RateLimit-*` and parsed the numbers back out. Fixed: `rateLimit` and `quota` in the result.
  - **No offsets in audit queries.** vante.app and bubblehouse-dk have numbered pages; vante.app read the table directly. Fixed: `query({ offset })`, up to 100,000, as the 2026-11-19 entry left open.
  - **Schedule runs leaked the `schedule:` prefix** into VaultDrop's job pages. Fixed: `list({ schedule })` and a `schedule` field on records.
  - **pino needs its arguments swapped**; VaultDrop and bubblehouse-dk each wrote the adapter. Fixed: `pinoLogger()`.
  - **Docs only:** renaming table exports that collide with the app's own (`import * as tables` picks up the app's `auditLog`); defining rules per request when the limit varies (three apps cached rules in a `Map` because the docs said "once, at module scope"); reusing an app secret is safe; an external cron on the same period as a schedule runs it only every other time.
  - **Not fixed, for later:**
    - `db` must exist at construction, but VaultDrop's `getDb()` is async, so it keeps one instance per connection.
    - `run()`'s `Jsonify<T>` needs a cast for a generic `T`.
    - bubblehouse-dk's audit table can't move without renaming columns at every reader, and `gw_audit_log` ids are identities, so its idempotent Mongo import would duplicate entries. A column mapping or explicit ids would make that move cheap.
    - Its outbox needs a fixed retry ladder, which `backoff` can't express.
    - Ticks are due `every` after the last one. A small tolerance, or a fixed grid, would make cron-driven schedules keep time.
- 2026-11-20: **bubblehouse-dk departs from the checklist.** Its audit log has six readers and three direct writers (two of them scripts that can't import `server-only` code), and its Mongo import writes ids of its own. Moving it would add code, change ids and lose the import's idempotency, for no new capability. Its mail outbox sends inline after payments, injects senders and a clock in tests, and retries on a fixed ladder (30 s, 2 min, 10 min, 30 min, then hourly). In a live shop's payment mail, I didn't want to change that behaviour without asking. It got rate limiting instead. Both moves are still open (section 9).
- 2026-11-20: Things noticed in the apps, not fixed (they aren't groundwork's):
  - Faultline's e2e "resolves and reopens several issues" fails on its main too: its events lack the `timestamp` its schema requires.
  - bubblehouse-dk's `bun audit` shows a dev-only esbuild advisory through drizzle-kit.
  - Faultline's docs promise PostgreSQL 15+. groundwork passes 158 of 159 tests on PG15; only the harness's version check fails. The supported range is an open decision in section 9.
- 2026-11-20: 0.2.0 is versioned (`22eb535`), with all 535 tests and the smoke test passing. It isn't tagged or pushed yet; the release waits for the owner. Once it's out, the apps can drop their glue: lazy getters, logger adapters, rule maps, vante.app's header parsing and VaultDrop's prefix handling.
- 2026-11-20: The owner merged all five apps' `feat/groundwork` branches (Faultline #1, vante.app #2, VaultDrop #15, bubblehouse-dk #3, Hookline #1). CI is green on every app's `main`.
- 2026-11-23: Hookline is the first app running groundwork in production (REST API rate limits), deployed on Railway from `0189635`. Getting there fixed three CI problems unrelated to groundwork: a new Go advisory in `klauspost/compress`, production images still on Go 1.27.3, and GoReleaser picking up the `deployed/production` tag as a version. It also fixed the deploy's Migrate check, which read the logs before the container had printed "Migrations applied.". Faultline's `main` CI was red since 2026-11-04 because an e2e test sent events without the required `timestamp`; that's fixed too.
- 2026-11-23: **Published 0.2.0** through trusted publishing, with provenance (shasum `6e472450…`). It took three attempts:
  1. `ENEEDAUTH`. npm logs why the OIDC exchange failed only at verbose level, and the workflow still passed an empty `NODE_AUTH_TOKEN` from the deleted `NPM_TOKEN` secret.
  2. With the owner's approval, `v0.2.0` moved from `34a675f` to `9f6593e`, which drops the token and prints npm's `oidc` log lines on failure. Nothing had been published under the old tag. The exchange then said `OIDC token exchange error - package not found`: no trusted-publisher entry on npmjs.com matched the run.
  3. The owner fixed the entry (repository `kaanxsrd/groundwork`, workflow `release.yml`, environment `npm`). Re-running the job published it.

  A fresh install loads all 9 subpaths, and `npm audit signatures` verifies the attestation. `docs/releasing.md` now covers `ENEEDAUTH` and how to check the trusted publisher.
- 2026-11-23: All five apps moved to 0.2.0, each on a `refactor/groundwork-0.2` branch, and pushed. They dropped the lazy getters, pino adapters, rule maps, vante.app's header parsing and VaultDrop's prefix handling. Faultline's worker now runs rate-limit cleanup without the secret. Each app's tests pass, and behaviour is unchanged.
- 2026-11-23: For 0.3.0, three items from the "not fixed, for later" list:
  - **Retry ladders:** `backoff: { delays: [...] }`, for bubblehouse-dk's outbox schedule (30 s, 2 min, 10 min, 30 min, then hourly). The owner chose not to move that outbox yet.
  - **Schedule timing:** ticks keep to a grid and are due up to `min(every / 10, 5s)` early. Missed slots aren't replayed. The owner chose this timing change over keeping the docs workaround.
  - **An async database:** documented, with no API change. groundwork only calls `execute()`, so `{ execute: async (q) => (await getDb()).execute(q) }` works.

  Still open: `run()`'s `Jsonify<T>` cast for generic results; an audit column mapping or explicit ids for bubblehouse-dk's audit log; Faultline and PostgreSQL 15.
- 2026-11-23: **Published 0.3.0** (first try, trusted publishing, provenance). VaultDrop's and vante.app's branches moved to it, as the two apps with schedules. The rest only rate-limit, which 0.3.0 doesn't change. The `Jsonify<T>` cast is documented rather than changed: no signature can avoid it without claiming JSON keeps `Date`s. The owner decided the two open items: Faultline requires PostgreSQL 16 (docs only), and bubblehouse-dk keeps its audit log and outbox. Nothing from Phase 7's dogfooding is left open.
- 2026-11-24: Toward 1.0's "documented and stable public API": an audit of all 138 exports against the docs found eight runtime exports no page mentioned (documented in `a52484b`). A generated API reference, `docs/api/`, now covers every type; TypeDoc runs from `tools/api-docs` on TypeScript 6, and CI fails if it's stale.
- 2026-11-24: Toward 1.0's "no open correctness bugs": a review of `src/` found nine issues, all fixed in 0.3.1, each with a test:
  - A long-running `work({ signal })` leaked one abort listener per idle poll.
  - `apiKeys.create()` retried on a unique violation thrown by its audit hook, inserting extra keys. Without a `tx`, a failed audit write also left an active key nobody held. Only the insert is retried now, and that key is deleted. The docs no longer claim the change and its audit entry share a transaction without `tx`.
  - A 1 s lease (jobs or idempotency) was renewed exactly as it expired. Renewal is now every third of the lease.
  - A job timeout over 24.8 days fired after 1 ms. Durations that drive a timer are now capped at 24 days when configured.
  - `rotate()` didn't retry a prefix collision; a per-key limit had no upper bound; a missing `scheduledAt` gave an Invalid Date; and `gw.jobs` could be cached without its cleanup schedules.

  1.0 still needs two apps confirmed in production. Hookline and vante.app serve groundwork today. VaultDrop and Faultline deploy, but can't reach their databases, as on their 20 November builds; that problem isn't groundwork's.
- 2026-11-24: Drizzle 1.0 (`1.0.0-rc.6`, the `rc` tag; `latest` is still 0.45.4), tried for the open question from 2026-11-19. With 1.0 installed, `src/` type-checks unchanged and node-postgres passes everything, but postgres-js failed 37 of 172 integration tests:
  - **The bug:** postgres-js runs `JSON.stringify` on any parameter the server types as `jsonb`. Drizzle 0.45 turns that off on every postgres-js client it wraps; 1.0 doesn't. groundwork bound already-encoded JSON as `$n::jsonb`, so it was encoded twice: job payloads, results and audit changes were stored as JSON strings, and creating an API key failed. Fixed: JSON goes as a `text` parameter and Postgres casts it (`jsonbParam`), which every driver sends unchanged. `tests/integration/json-params.test.ts` puts a postgres-js client's own serializers back after Drizzle wrapped it, so it covers this on 0.45 too; the old code fails 3 of its 4 tests. With the fix, all 172 pass on 1.0 with both drivers.
  - **Types:** groundwork's own API accepts a Drizzle 1.0 database as it is (`GroundworkDatabase` is structural). The table types don't carry over: the emitted `.d.ts` spells out the installed Drizzle's column types (`PgColumn<{ columnType: "PgUUID" … }>` from 0.45, `PgBuildColumn` from 1.0), so a package built against 0.45 can't be used in `db.select().from(tables.auditLog)` on 1.0, and the other way round. `docs/audit.md` and `docs/schema.md` show such queries. One package can't type its tables for both majors without types that pick a branch by Drizzle version and report errors under `skipLibCheck: false`.
  - **Migrations:** drizzle-kit 1.0 refuses the old folder format until `drizzle-kit up` converts it (Drizzle's own one-time step), and then finds no changes in the fixture schema. A fresh 1.0 `generate` gives the same DDL in a new spelling (`PRIMARY KEY` without `NOT NULL`, no `USING btree`). Drizzle 1.0's `migrate()` throws on a folder with `meta/_journal.json`, so the test harness and the smoke test would need converted migrations to run on 1.0.
  - The peer range stays `^0.45.0` until the owner decides how to support 1.0 (section 9).

## 11. Alternatives check (2026-11-19)

The Phase 0 re-check of section 1. Versions are from the npm registry. Two claims were confirmed against the published tarballs: the pg-boss Drizzle adapter and `RateLimiterDrizzle`. The rest comes from each project's docs and changelogs.

**What changed since section 1 was written**

- **pg-boss 12.38** can now enqueue inside the app's Drizzle transaction (`fromDrizzle(tx)`), and transactional workers get a `tx` too. It still owns a `pgboss` schema and migrates on `start()`. ([adapters](https://pgboss.io/api/adapters), [workers](https://pgboss.io/api/workers))
- **rate-limiter-flexible 11.5** ships `RateLimiterDrizzle`. The table lives in your Drizzle schema, and each consume is one atomic upsert (made atomic in 11.4.0, 2026-11-08). It has fixed window only, uses the app's clock, takes no `tx`, and stores plain-string keys. ([wiki](https://github.com/animir/node-rate-limiter-flexible/wiki/Drizzle))
- **better-auth's API keys** moved to `@better-auth/api-key`. It has no rotation and no IP allowlist, and hashes with unkeyed SHA-256.
- **Unkey** shipped rotation with a 15 m–24 h grace period and root-key IP allowlists. Its open-source status is unclear: the GitHub repo returned 404 on 2026-11-19.
- No library bundles these five pieces. The nearest small ones are drizzle-audit (a `pgAuditTable()` factory that intercepts ORM writes), @absolutejs/queue-postgres (SKIP LOCKED with the table in your schema) and keypal (keys with a Drizzle adapter).

**Reasons to drop a module:** none. **To reposition:** jobs, and the fixed-window half of rate limiting. Proposals are below. None of them is applied yet, because they change the specs in section 6.

1. **Jobs (6.4):** *adopted in Phase 4: `docs/jobs.md` opens with when to use pg-boss or graphile-worker instead. `jobKey` modes and OTel names are not done.* "enqueue inside your transaction" no longer sets us apart. What does: the tables live in your schema and drizzle-kit, job types are typed, the claim is a single statement with leases (graphile-worker without Pro leaves crashed jobs locked for up to 4 hours), and there's an HTTP `runOnce` for serverless. Say so in the README, and document pg-boss as the next step for workflows or very high volume. Ideas worth copying:
   - graphile-worker's `jobKey` modes (`replace`, `preserve_run_at`) for debouncing;
   - pg-boss keeps expiry and heartbeat as separate settings;
   - OpenTelemetry-compatible span names (later).
2. **Rate limiting (6.1):** *adopted in Phase 1, except the response fields: there's no `reason` (the fallback mode is in `degraded`), `resetAt` stays a `Date` as in section 5, and the wait is `retryAfterMs`.* Lead with token bucket, typed rules, headers and the in-memory fallback. Phase 1 needs three decisions:
   - **time source:** Postgres `now()` avoids clock skew between app instances, but the fake-clock must-pass test needs the injected clock. Proposal: the SQL uses a timestamp parameter from the injected clock when one is given, and Postgres time otherwise;
   - **over-budget cost:** when `cost` is more than what's left, reject without consuming. @upstash/ratelimit 2.2 changed to this;
   - **response fields:** `reason` and `resetAt` in milliseconds, as upstash returns.
   
   RateLimit headers: the current draft is [draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/) (`RateLimit` and `RateLimit-Policy` fields). Re-check it in Phase 1.
3. **API keys (6.3):** the planned `reason` enum is close to Unkey's verify codes, so keep it. Copy GitHub's approach for checksums and prefixes that secret scanners can recognize ([GitHub blog](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)). Also, **vante.app stores `HMAC(pepper, key)` with the raw pepper, but groundwork will use an HKDF subkey.** Existing vante keys won't verify after the Phase 7 migration unless Phase 3 adds a verify-only legacy hash option or the keys are re-issued. Decide in Phase 3.
4. **Idempotency (6.5):** *adopted in Phase 5.* The least crowded space, so feature it. Follow [draft-ietf-httpapi-idempotency-key-header-08](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/): 400 when a required key is missing, 422 for a different body, 409 while the first request is in flight.
5. **Audit (6.2):** drizzle-audit is the closest rival. Keep explicit, typed, in-transaction `record()` rather than ORM interception.
