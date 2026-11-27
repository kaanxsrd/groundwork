# @vantedev/groundwork/rate-limit

`@vantedev/groundwork/rate-limit`: fixed-window and token-bucket rate limiting in Postgres, with an
in-memory fallback and an optional Redis store.

```ts
import { createRateLimiter } from "@vantedev/groundwork/rate-limit";

const limiter = createRateLimiter({ db, table: rateLimits, secret: env.GROUNDWORK_SECRET });
export const loginLimit = limiter.rule({ name: "login:ip", limit: 5, window: "15m" });
export const apiLimit = limiter.rule({ name: "api", algorithm: "token-bucket", rate: 10, per: "1s", burst: 120 });
```

## Interfaces

### CheckOptions

#### Properties

##### cost?

> `readonly` `optional` **cost?**: `number`

How much this request uses, for example the number of events in a batch. Defaults to 1.
`0` reads the current state without using anything. A request whose cost does not fit is
rejected without using anything, so one oversized request never burns the rest of a window.

***

### FixedWindowRuleOptions

At most `limit` cost per `window`. The window starts at a subject's first request.

#### Extends

- `RuleOptionsBase`

#### Properties

##### algorithm?

> `readonly` `optional` **algorithm?**: `"fixed-window"`

##### burst?

> `readonly` `optional` **burst?**: `undefined`

##### limit

> `readonly` **limit**: `number`

Cost allowed per window. A positive integer.

##### name

> `readonly` **name**: `string`

Identifies the rule, for example `"login:ip"`. It is part of every stored key and is sent in
the `RateLimit-Policy` header, so it may use letters, digits and `_ . : / -` only.

###### Inherited from

`RuleOptionsBase.name`

##### onError?

> `readonly` `optional` **onError?**: [`OnError`](#onerror-2)

Overrides the limiter's `onError` for this rule.

###### Inherited from

`RuleOptionsBase.onError`

##### per?

> `readonly` `optional` **per?**: `undefined`

##### rate?

> `readonly` `optional` **rate?**: `undefined`

##### window

> `readonly` **window**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

***

### IpSubjectOptions

#### Properties

##### ipv6Prefix?

> `readonly` `optional` **ipv6Prefix?**: `number`

How many leading bits of an IPv6 address make one subject: 32 to 128. Defaults to 64, the
smallest network a client usually gets, so one client can't escape a limit by switching
addresses inside it. 128 limits each address on its own.

***

### MemoryStore

Where a limiter keeps its counters instead of Postgres: `redisStore()`, or `memoryStore()` for
tests and single-instance apps. Its members are internal, so a store can only come from
groundwork, and how stores work can change without a breaking release.

#### Extends

- [`RateLimitStore`](#ratelimitstore)

#### Properties

##### \[OPAQUE\]

> `readonly` **\[OPAQUE\]**: `true`

###### Inherited from

[`RateLimitStore`](#ratelimitstore).[`[OPAQUE]`](#opaque-1)

##### size

> `readonly` **size**: `number`

How many subjects are held right now.

***

### MemoryStoreOptions

#### Properties

##### clock?

> `readonly` `optional` **clock?**: [`Clock`](../groundwork.md#clock)

Used when a check doesn't pass its own time. Defaults to the system clock.

##### maxKeys?

> `readonly` `optional` **maxKeys?**: `number`

Most subjects kept at once. When full, the least recently used subject is forgotten, which
resets its count. Defaults to 10,000.

***

### RateLimiter

#### Methods

##### cleanup()

> **cleanup**(): `Promise`\<`number`\>

Deletes expired rows. Run it every hour or so; returns how many rows it deleted.

###### Returns

`Promise`\<`number`\>

##### rule()

> **rule**(`options`): [`RateLimitRule`](#ratelimitrule)

Defines a rule. It does no I/O, so a rule can be defined per request when its limit varies.
Rules with the same algorithm and name share counters.

###### Parameters

###### options

[`RuleOptions`](#ruleoptions)

###### Returns

[`RateLimitRule`](#ratelimitrule)

***

### RateLimitResult

#### Properties

##### allowed

> `readonly` **allowed**: `boolean`

##### degraded

> `readonly` **degraded**: `false` \| [`OnError`](#onerror-2)

`false` normally. When the store failed, the `onError` mode that produced this result.

##### headers

> `readonly` **headers**: `Readonly`\<`Record`\<`string`, `string`\>\>

`RateLimit-Policy` and `RateLimit` (draft-ietf-httpapi-ratelimit-headers-11), plus
`Retry-After` when denied. Pass straight to a `Response`.

##### limit

> `readonly` **limit**: `number`

The window's limit, or the bucket's burst size.

##### remaining

> `readonly` **remaining**: `number`

Cost still available right now, after this request.

##### resetAt

> `readonly` **resetAt**: `Date`

When the window ends, or when the bucket will be full again.

##### retryAfterMs

> `readonly` **retryAfterMs**: `number`

How long to wait before this request would be allowed. 0 when allowed.

***

### RateLimitRule

#### Properties

##### algorithm

> `readonly` **algorithm**: [`RateLimitAlgorithm`](#ratelimitalgorithm)

##### name

> `readonly` **name**: `string`

#### Methods

##### check()

> **check**(`subject`, `options?`): `Promise`\<[`RateLimitResult`](#ratelimitresult)\>

Uses `cost` (default 1) for `subject`, an IP address, user id or API key id. One round trip.

###### Parameters

###### subject

`string`

###### options?

[`CheckOptions`](#checkoptions)

###### Returns

`Promise`\<[`RateLimitResult`](#ratelimitresult)\>

##### reset()

> **reset**(`subject`, `options?`): `Promise`\<`void`\>

Forgets `subject`'s usage, for example after a successful login.

###### Parameters

###### subject

`string`

###### options?

[`ResetOptions`](#resetoptions)

###### Returns

`Promise`\<`void`\>

***

### RateLimitStore

Where a limiter keeps its counters instead of Postgres: `redisStore()`, or `memoryStore()` for
tests and single-instance apps. Its members are internal, so a store can only come from
groundwork, and how stores work can change without a breaking release.

#### Extended by

- [`MemoryStore`](#memorystore)

#### Properties

##### \[OPAQUE\]

> `readonly` **\[OPAQUE\]**: `true`

***

### RedisEvalClient

The one Redis capability the store needs: running a Lua script. Adapt your client in one line:

```ts
// ioredis
const client = { eval: (script, keys, args) => redis.eval(script, keys.length, ...keys, ...args) };
// node-redis
const client = { eval: (script, keys, args) => redis.eval(script, { keys, arguments: args }) };
```

#### Methods

##### eval()

> **eval**(`script`, `keys`, `args`): `Promise`\<`unknown`\>

###### Parameters

###### script

`string`

###### keys

`string`[]

###### args

`string`[]

###### Returns

`Promise`\<`unknown`\>

***

### RedisStoreOptions

#### Properties

##### client

> `readonly` **client**: [`RedisEvalClient`](#redisevalclient)

##### prefix?

> `readonly` `optional` **prefix?**: `string`

Prepended to every Redis key. Defaults to `"gw:rl:"`.

***

### ResetOptions

#### Properties

##### tx?

> `readonly` `optional` **tx?**: [`GroundworkDatabase`](../groundwork.md#groundworkdatabase)

Run the reset inside this transaction (Postgres store only).

***

### TokenBucketRuleOptions

A bucket of `burst` tokens that refills at `rate` tokens per `per`. Allows short bursts while
holding the long-run rate.

#### Extends

- `RuleOptionsBase`

#### Properties

##### algorithm

> `readonly` **algorithm**: `"token-bucket"`

##### burst?

> `readonly` `optional` **burst?**: `number`

Bucket size: the most cost allowed at once. A positive integer. Defaults to `rate`.

##### limit?

> `readonly` `optional` **limit?**: `undefined`

##### name

> `readonly` **name**: `string`

Identifies the rule, for example `"login:ip"`. It is part of every stored key and is sent in
the `RateLimit-Policy` header, so it may use letters, digits and `_ . : / -` only.

###### Inherited from

`RuleOptionsBase.name`

##### onError?

> `readonly` `optional` **onError?**: [`OnError`](#onerror-2)

Overrides the limiter's `onError` for this rule.

###### Inherited from

`RuleOptionsBase.onError`

##### per

> `readonly` **per**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

##### rate

> `readonly` **rate**: `number`

Tokens added per `per`. A positive integer.

##### window?

> `readonly` `optional` **window?**: `undefined`

## Type Aliases

### OnError

> **OnError** = `"memory"` \| `"allow"` \| `"deny"`

What a rule does when its store (Postgres or Redis) fails or times out:

- `"memory"`: count in this process's memory until the store is back. Limits hold per instance.
- `"allow"`: let every request through (fail open).
- `"deny"`: reject every request (fail closed).

***

### RateLimitAlgorithm

> **RateLimitAlgorithm** = `"fixed-window"` \| `"token-bucket"`

***

### RateLimiterOptions

> **RateLimiterOptions** = `CommonOptions` & (\{ `db`: [`GroundworkDatabase`](../groundwork.md#groundworkdatabase); `store?`: `undefined`; `table`: [`RateLimitsTable`](schema.md#ratelimitstable); \} \| \{ `db?`: `undefined`; `store`: [`RateLimitStore`](#ratelimitstore); `table?`: `undefined`; \})

***

### RuleOptions

> **RuleOptions** = [`FixedWindowRuleOptions`](#fixedwindowruleoptions) \| [`TokenBucketRuleOptions`](#tokenbucketruleoptions)

## Functions

### createRateLimiter()

> **createRateLimiter**(`options`): [`RateLimiter`](#ratelimiter)

Creates a rate limiter. Define rules on it once, at module scope:

```ts
const limiter = createRateLimiter({ db, table: rateLimits, secret: env.GROUNDWORK_SECRET });
export const loginLimit = limiter.rule({ name: "login:ip", limit: 5, window: "15m" });

const result = await loginLimit.check(ip);
if (!result.allowed) return new Response("Too many attempts", { status: 429, headers: result.headers });
```

#### Parameters

##### options

[`RateLimiterOptions`](#ratelimiteroptions)

#### Returns

[`RateLimiter`](#ratelimiter)

***

### ipSubject()

#### Call Signature

> **ipSubject**(`ip`, `options?`): `string`

The subject to rate-limit a client IP address by. IPv4 addresses are limited one by one. An
IPv6 address counts as its /64 network, because a single client usually holds a whole /64 and
can send every request from another address in it. IPv4-mapped IPv6 (`::ffff:203.0.113.7`)
counts as the IPv4 address.

`null` and `undefined` come back as `null`, so it fits `clientIp(request)`, and a `null`
subject lets `withRateLimit` through without counting. Anything that isn't an IP address throws
`invalid_argument`, without repeating the value.

```ts
withRateLimit(signups, (request) => ipSubject(clientIp(request)), handleSignup);
await loginLimit.check(ipSubject("2001:db8:1:2:aaaa::1")); // "2001:db8:1:2::/64"
```

##### Parameters

###### ip

`string`

###### options?

[`IpSubjectOptions`](#ipsubjectoptions)

##### Returns

`string`

#### Call Signature

> **ipSubject**(`ip`, `options?`): `string` \| `null`

The subject to rate-limit a client IP address by. IPv4 addresses are limited one by one. An
IPv6 address counts as its /64 network, because a single client usually holds a whole /64 and
can send every request from another address in it. IPv4-mapped IPv6 (`::ffff:203.0.113.7`)
counts as the IPv4 address.

`null` and `undefined` come back as `null`, so it fits `clientIp(request)`, and a `null`
subject lets `withRateLimit` through without counting. Anything that isn't an IP address throws
`invalid_argument`, without repeating the value.

```ts
withRateLimit(signups, (request) => ipSubject(clientIp(request)), handleSignup);
await loginLimit.check(ipSubject("2001:db8:1:2:aaaa::1")); // "2001:db8:1:2::/64"
```

##### Parameters

###### ip

`string` \| `null` \| `undefined`

###### options?

[`IpSubjectOptions`](#ipsubjectoptions)

##### Returns

`string` \| `null`

***

### memoryStore()

> **memoryStore**(`options?`): [`MemoryStore`](#memorystore)

Counters in this process's memory, with the same semantics as the Postgres and Redis stores.
Each instance enforces its own limits, so use it for tests, single-instance apps, or (as the
limiter does) as the fallback while the real store is down.

#### Parameters

##### options?

[`MemoryStoreOptions`](#memorystoreoptions) = `{}`

#### Returns

[`MemoryStore`](#memorystore)

***

### redisStore()

> **redisStore**(`options`): [`RateLimitStore`](#ratelimitstore)

Counters in Redis, for apps that already run it. Postgres stays the default.

#### Parameters

##### options

[`RedisStoreOptions`](#redisstoreoptions)

#### Returns

[`RateLimitStore`](#ratelimitstore)
