# Rate limiting

Fixed-window and token-bucket rate limits stored in your Postgres, checked in one round trip, and correct across any number of app instances. Redis is optional, and an in-memory fallback keeps working while the store is down.

## Quickstart

1. Export the table and generate a migration ([table factories](schema.md)):

   ```ts
   // src/db/schema/groundwork.ts
   import { groundworkTables } from "@vantedev/groundwork/schema";
   export const { rateLimits } = groundworkTables();
   ```

2. Create a limiter and define rules, usually at module scope:

   ```ts
   // src/lib/rate-limits.ts
   import { createGroundwork } from "@vantedev/groundwork";
   import { db } from "@/db";
   import * as tables from "@/db/schema/groundwork";

   export const gw = createGroundwork({ db, tables, secret: process.env.GROUNDWORK_SECRET! });

   export const loginLimit = gw.rateLimit.rule({ name: "login:ip", limit: 5, window: "15m" });
   export const apiLimit = gw.rateLimit.rule({
     name: "api",
     algorithm: "token-bucket",
     rate: 10,
     per: "1s",
     burst: 120,
   });
   ```

   Using only rate limiting? `createRateLimiter({ db, table: rateLimits, secret })` from `@vantedev/groundwork/rate-limit` does the same without `createGroundwork`.

3. Check, and pass the headers on:

   ```ts
   // ipSubject, from "@vantedev/groundwork/rate-limit": one subject per IPv6 /64 (see below).
   const result = await loginLimit.check(ipSubject(ip));
   if (!result.allowed) {
     return new Response("Too many attempts", { status: 429, headers: result.headers });
   }
   ```

## Algorithms

**Fixed window** (the default): at most `limit` cost per `window`. A subject's window starts at its first request and ends `window` later, so subjects don't all reset at the same moment. A burst can reach twice the limit across the boundary of two windows; if that matters, use a token bucket.

```ts
gw.rateLimit.rule({ name: "signup:ip", limit: 3, window: "1h" });
```

**Token bucket**: a bucket of `burst` tokens that refills at `rate` per `per`. Clients can burst up to `burst`, then settle to the rate. `burst` defaults to `rate`.

```ts
gw.rateLimit.rule({ name: "api", algorithm: "token-bucket", rate: 10, per: "1s", burst: 120 });
```

Durations are [strings with a unit](core-concepts.md#durations). `limit`, `rate` and `burst` are positive integers. A rule's `name` may use letters, digits and `_ . : / -`, because it goes into a response header.

### Limits that vary per request

Defining a rule is cheap: it checks the options and returns two functions, with no I/O. When the limit depends on the request, such as a customer's plan, or an existing `rateLimit(key, { max, windowSeconds })` helper you're keeping, define the rule where you check it. There's no need to cache rules yourself:

```ts
const rule = gw.rateLimit.rule({ name: "api:plan", limit: plan.requestsPerMinute, window: "1m" });
const result = await rule.check(apiKeyId);
```

Counters are keyed by the rule's algorithm, name and subject. Rules with the same name therefore share a counter: a key that changes plan keeps what it used in the current window, under the new limit. To count separately, put the limit in the name (`"export:5per1h"`).

## Checking

```ts
const result = await rule.check(subject, { cost: 1 });
```

The `subject` is whatever you limit by: an IP address, a user id, an API key id. groundwork stores an HMAC of it, never the value itself.

### Limiting by IP address

Pass an address through `ipSubject()` rather than using it as it is:

```ts
import { ipSubject } from "@vantedev/groundwork/rate-limit";

const result = await loginLimit.check(ipSubject(ip));
```

- **IPv6 counts by network.** A single client usually holds a whole `/64`: 18 quintillion addresses it can send each request from. Limited per address, it would never hit the limit. `ipSubject("2001:db8:1:2::abcd")` is `"2001:db8:1:2::/64"`. Some providers give each customer a `/56` or a `/48`; `ipSubject(ip, { ipv6Prefix: 56 })` limits those as one.
- **IPv4 counts by address.** Behind carrier-grade NAT many people share one address, so anything wider would block them together.
- **One spelling.** Case, leading zeros, brackets and zone ids don't change the subject, and an IPv4-mapped address (`::ffff:203.0.113.7`) counts as the IPv4 address it carries.
- `null` comes back as `null`, so `ipSubject(clientIp(request))` works with [`withRateLimit`](next.md#withratelimitrule-key-handler), where a `null` subject isn't counted. Anything that isn't an IP address throws `invalid_argument`, without repeating the value.

Switching an existing rule to `ipSubject()`, or changing `ipv6Prefix`, changes its subjects, so those counts start over.

**`cost`** (default 1) is how much this request uses, for example the number of events in a batch. A request whose cost doesn't fit is denied **and uses nothing**, so one oversized batch can't burn the rest of a window. A cost above the limit or burst is always denied. `cost: 0` reads the current state without using anything.

The result:

| Field | Meaning |
| --- | --- |
| `allowed` | Whether to serve the request. |
| `limit` | The window's limit or the bucket's burst. |
| `remaining` | Cost still available right now, after this request. |
| `resetAt` | When the window ends, or when the bucket will be full again. |
| `retryAfterMs` | How long until this request would be allowed. `0` when allowed. |
| `headers` | Ready-made response headers (below). |
| `degraded` | `false` normally. `"memory"`, `"allow"` or `"deny"` when the store failed and that fallback answered (see [failures](#when-the-store-fails)). |

### Headers

`result.headers` follows the IETF draft [`draft-ietf-httpapi-ratelimit-headers-11`](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/):

```http
RateLimit-Policy: "login:ip";q=5;w=900
RateLimit: "login:ip";r=0;t=412
Retry-After: 412
```

- `RateLimit-Policy`: the quota `q` per window `w` (seconds). A token bucket is described by its sustained rate in whole seconds, so 5 per 500ms becomes `q=10;w=1`.
- `RateLimit`: `r` is the remaining quota. `t` is the seconds until the window resets or the bucket is full; when denied, it's the seconds until a retry can succeed.
- `Retry-After`: only on a denial, in whole seconds (at least 1).

To send other headers (such as `X-RateLimit-*`), build them from `limit`, `remaining` and `resetAt`.

## When the store fails

If Postgres (or Redis) throws, or doesn't answer within `timeout` (default `"1s"`), each rule falls back to its `onError` mode:

| `onError` | Behaviour |
| --- | --- |
| `"memory"` (default) | Count in this process's memory. Limits still hold, per instance. |
| `"allow"` | Let every request through (fail open). |
| `"deny"` | Reject every request (fail closed). `Retry-After` points at the next attempt to reach the store. |

Set it for the whole limiter (`createGroundwork({ rateLimit: { onError } })`) or per rule (`rule({ …, onError: "deny" })`). Fail closed where abuse is worse than an outage, such as login.

After a failure, the limiter skips the store for 5 seconds instead of waiting on a dead connection for every request, then tries again. The outage is **logged once** at `error` level, with the store kind and error but never a subject. Recovery is logged at `info` (or `warn`, if your logger has no `info`). Results produced by a fallback have `degraded` set, so you can count them.

The in-memory fallback keeps at most `memory.maxKeys` subjects (default 10,000) and forgets the least recently used first. Subjects that are being denied count as used, so a client can't escape its limit by flooding the fallback with new subjects.

## Stores

**Postgres** is the default: pass `db` and the `rateLimits` table. Each check is a single SQL statement (an `INSERT … ON CONFLICT … DO UPDATE … WHERE`), so concurrent checks for one subject serialise on its row and can't overspend, however many app instances you run. It works with any Drizzle Postgres driver.

**Redis**, if you already run it:

```ts
import { redisStore } from "@vantedev/groundwork/rate-limit";

// ioredis
const store = redisStore({
  client: { eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) },
});
// node-redis
const store = redisStore({
  client: { eval: (script, keys, args) => redis.eval(script, { keys, arguments: args }) },
});

createGroundwork({ db, tables, secret, rateLimit: { store } });
```

One Lua script per check, with the same semantics as Postgres. Keys are `gw:rl:<hmac>` (change it with `prefix`) and expire on their own, so `cleanup()` has nothing to do. groundwork doesn't depend on any Redis client: the adapter is the one line above.

**Memory**, for tests or a single-instance app: `memoryStore()`. Each process counts on its own.

## Time

By default each store uses its own clock: Postgres's `clock_timestamp()`, or Redis's `TIME`. App instances with skewed clocks still agree about when a window ends. Inject a `clock` to control time in tests:

```ts
import { createTestClock } from "@vantedev/groundwork/testing";

const clock = createTestClock("2026-01-01T00:00:00Z");
const limiter = createRateLimiter({ db, table: rateLimits, secret, clock });
clock.advance("15m");
```

## Resetting and cleaning up

```ts
await loginLimit.reset(ipSubject(ip)); // after a successful login: the same subject check() used
```

With the Postgres store, `reset` can join your transaction: `reset(ipSubject(ip), { tx })`.

Checks don't take a transaction, on purpose. A failed login usually rolls back, and its attempt must still count. A check inside a long transaction would also hold the counter's row lock until that transaction ends.

Expired rows are harmless (an expired row counts as empty), but they take space. Delete them every hour or so:

```ts
const deleted = await gw.rateLimit.cleanup();
```

It deletes in batches and skips rows other checks are using. With the jobs module set up, `createGroundwork` schedules it every hour as `groundwork.rate-limit-cleanup`.

## What's stored, and what isn't

- The subject is HMAC-SHA256'd with a key derived from your secret. The raw value is never stored, logged or put in an error.
- The rule name is stored as is, so operators can see which rules are busy.
- Changing the secret changes every key, which resets every limit, even with `previousSecrets`. See [rotating the secret](core-concepts.md#rotating-the-secret).

## Replacing a hand-rolled limiter

Faultline's in-memory limiter maps over directly:

```ts
// before: rateLimit(`ingest:${project.id}`, EVENTS_PER_MINUTE, 60_000, events.length)
const ingestLimit = gw.rateLimit.rule({ name: "ingest", limit: EVENTS_PER_MINUTE, window: "1m" });
const limit = await ingestLimit.check(project.id, { cost: events.length });
if (!limit.allowed) {
  return reply(429, { error: { code: "rate_limited", retryAfter: Math.ceil(limit.retryAfterMs / 1000) } }, limit.headers);
}
```

- `ok` becomes `allowed`.
- `remaining` is unchanged.
- `retryAfter` (seconds) becomes `Math.ceil(retryAfterMs / 1000)`, and `Retry-After` comes ready-made in `headers`.

A differential test runs this kind of limiter next to groundwork over thousands of random requests. Answers are identical for cost-1 traffic. For batches, groundwork lets strictly more through, because a denied batch no longer counts, and never exceeds the limit. The one change to calling code is that `check` is async.
