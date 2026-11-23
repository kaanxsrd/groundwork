# @vantedev/groundwork/next

`@vantedev/groundwork/next`: route-handler helpers for Next.js. They only use the Web `Request` and
`Response`, so they also work in any framework with the same handler shape.

```ts
// lib/route.ts
import { createRouteHelpers } from "@vantedev/groundwork/next";
export const { withApiKey, withRateLimit, withIdempotency, clientIp } =
  createRouteHelpers(gw, { trustProxy: "vercel" });

// app/api/posts/route.ts
export const POST = withApiKey(
  ["posts:write"],
  withIdempotency({ scope: (_request, { apiKey }) => `apikey:${apiKey.id}` }, async (request) =>
    Response.json(await createPost(await request.json()), { status: 201 }),
  ),
);

// app/api/jobs/route.ts
export const GET = jobsRoute(gw, { secret: env.CRON_SECRET });
export const POST = GET;
```

## Interfaces

### ApiKeyContext

What `withApiKey` adds to the context.

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Properties

##### apiKey

> `readonly` **apiKey**: [`ApiKeyRecord`](api-keys.md#apikeyrecord)\<`TScope`\>

***

### ClientIpOptions

#### Properties

##### trustProxy?

> `readonly` `optional` **trustProxy?**: [`TrustProxy`](#trustproxy-2)

Defaults to `"none"`.

***

### DefaultRouteContext

The second argument Next.js passes a route handler. Use your route's own type for typed params:
`withApiKey<RouteContext<"/posts/[id]">>(…)`.

#### Properties

##### params

> `readonly` **params**: `Promise`\<`Record`\<`string`, `string` \| `string`[] \| `undefined`\>\>

***

### JobsRouteOptions

#### Properties

##### budgetMs?

> `readonly` `optional` **budgetMs?**: `number`

Stop claiming new jobs after this long, then wait for running ones. Defaults to 10,000 ms.

##### concurrency?

> `readonly` `optional` **concurrency?**: `number`

Jobs run at once. Defaults to 4.

##### secret

> `readonly` **secret**: `string`

The bearer token callers must send (`Authorization: Bearer <secret>`), at least 16
characters. On Vercel, name it `CRON_SECRET` and Vercel Cron sends it for you.

***

### RouteHelperModules

The modules the helpers use: pass `gw` from `createGroundwork`, or your own modules.

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Properties

##### apiKeys?

> `readonly` `optional` **apiKeys?**: [`ApiKeys`](api-keys.md#apikeys)\<`TScope`\>

##### idempotency?

> `readonly` `optional` **idempotency?**: [`Idempotency`](idempotency.md#idempotency)

***

### RouteHelpers

#### Type Parameters

##### TScope

`TScope` *extends* `string`

#### Methods

##### clientIp()

> **clientIp**(`input`): `string` \| `null`

The client's IP, from the header `trustProxy` names, or `null`.

###### Parameters

###### input

`Request` \| `Headers`

###### Returns

`string` \| `null`

##### withApiKey()

###### Call Signature

> **withApiKey**\<`TRequest`\>(`scopes`, `handler`): (`request`, `context`) => `Promise`\<`Response`\>

Requires an API key with every scope in `scopes`. Failures get the JSON 401, 403 or 429 from
`verify`; the key reaches the handler as `context.apiKey`, and its rate-limit headers are added
to the response. Wrappers nested inside see `apiKey` too.

###### Type Parameters

###### TRequest

`TRequest` *extends* `Request` = `Request`

###### Parameters

###### scopes

readonly `TScope`[]

###### handler

[`RouteHandler`](#routehandler)\<[`DefaultRouteContext`](#defaultroutecontext) & [`ApiKeyContext`](#apikeycontext)\<`TScope`\>, `TRequest`\>

###### Returns

(`request`, `context`) => `Promise`\<`Response`\>

###### Call Signature

> **withApiKey**\<`TContext`, `TRequest`\>(`scopes`, `handler`): (`request`, `context`) => `Promise`\<`Response`\>

With your route's context type, for typed params: `withApiKey<RouteContext<"/posts/[id]">>(…)`.

###### Type Parameters

###### TContext

`TContext`

###### TRequest

`TRequest` *extends* `Request` = `Request`

###### Parameters

###### scopes

readonly `TScope`[]

###### handler

[`RouteHandler`](#routehandler)\<`TContext` & [`ApiKeyContext`](#apikeycontext)\<`TScope`\>, `TRequest`\>

###### Returns

(`request`, `context`) => `Promise`\<`Response`\>

##### withIdempotency()

> **withIdempotency**\<`TContext`, `TRequest`\>(`options`, `handler`): (`request`, `context`) => `Promise`\<`Response`\>

Makes the handler safe to retry with an `Idempotency-Key` header. See `Idempotency.handle`.

###### Type Parameters

###### TContext

`TContext` = [`DefaultRouteContext`](#defaultroutecontext)

###### TRequest

`TRequest` *extends* `Request` = `Request`

###### Parameters

###### options

[`WithIdempotencyOptions`](#withidempotencyoptions)\<`TContext`, `TRequest`\>

###### handler

[`RouteHandler`](#routehandler)\<`TContext`, `TRequest`\>

###### Returns

(`request`, `context`) => `Promise`\<`Response`\>

##### withRateLimit()

> **withRateLimit**\<`TContext`, `TRequest`\>(`rule`, `key`, `handler`): (`request`, `context`) => `Promise`\<`Response`\>

Checks `rule` for the subject `key` returns. Over the limit: a JSON 429 with `Retry-After` and
`RateLimit` headers. Otherwise the rate-limit headers are added to the handler's response.

###### Type Parameters

###### TContext

`TContext` = [`DefaultRouteContext`](#defaultroutecontext)

###### TRequest

`TRequest` *extends* `Request` = `Request`

###### Parameters

###### rule

[`RateLimitRule`](rate-limit.md#ratelimitrule)

###### key

[`RateLimitKey`](#ratelimitkey)\<`TContext`, `TRequest`\>

###### handler

[`RouteHandler`](#routehandler)\<`TContext`, `TRequest`\>

###### Returns

(`request`, `context`) => `Promise`\<`Response`\>

***

### RouteHelpersOptions

#### Properties

##### trustProxy?

> `readonly` `optional` **trustProxy?**: [`TrustProxy`](#trustproxy-2)

Where the client's IP comes from, for API-key allowlists and `clientIp()`. Defaults to `"none"`.

***

### WithIdempotencyOptions

#### Extends

- `Omit`\<[`HandleOptions`](idempotency.md#handleoptions), `"scope"`\>

#### Type Parameters

##### TContext

`TContext`

##### TRequest

`TRequest` *extends* `Request`

#### Properties

##### fingerprint?

> `readonly` `optional` **fingerprint?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

What identifies the request, instead of its method, path and body. Pass it when you've already
read the body, for example the validated input as JSON.

###### Inherited from

[`HandleOptions`](idempotency.md#handleoptions).[`fingerprint`](idempotency.md#fingerprint)

##### required?

> `readonly` `optional` **required?**: `boolean`

Reject requests without an `Idempotency-Key` header (400). Defaults to `false`: they run unprotected.

###### Inherited from

[`HandleOptions`](idempotency.md#handleoptions).[`required`](idempotency.md#required)

##### scope

> `readonly` **scope**: `string` \| ((`request`, `context`) => `string` \| `Promise`\<`string`\>)

Whose keys these are, or a function that works it out from the request.

##### ttl?

> `readonly` `optional` **ttl?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

How long a completed response is replayed. Defaults to the module's `ttl`.

###### Inherited from

[`HandleOptions`](idempotency.md#handleoptions).[`ttl`](idempotency.md#ttl)

## Type Aliases

### RateLimitKey

> **RateLimitKey**\<`TContext`, `TRequest`\> = (`request`, `context`) => `string` \| `null` \| `undefined` \| `Promise`\<`string` \| `null` \| `undefined`\>

Returns a subject to limit by, or `null`/`undefined` to let this request through unlimited.

#### Type Parameters

##### TContext

`TContext`

##### TRequest

`TRequest` *extends* `Request`

#### Parameters

##### request

`TRequest`

##### context

`TContext`

#### Returns

`string` \| `null` \| `undefined` \| `Promise`\<`string` \| `null` \| `undefined`\>

***

### RouteHandler

> **RouteHandler**\<`TContext`, `TRequest`\> = (`request`, `context`) => `Response` \| `Promise`\<`Response`\>

A Next.js route handler: `export const POST: RouteHandler = …`.

#### Type Parameters

##### TContext

`TContext` = [`DefaultRouteContext`](#defaultroutecontext)

##### TRequest

`TRequest` *extends* `Request` = `Request`

#### Parameters

##### request

`TRequest`

##### context

`TContext`

#### Returns

`Response` \| `Promise`\<`Response`\>

***

### TrustProxy

> **TrustProxy** = `"none"` \| `"vercel"` \| `"cloudflare"` \| \{ `header`: `string`; `hops?`: `number`; \}

Which proxy header to take the client's IP from. Headers are trusted only when a proxy you
control sets them, so the default is `"none"`.

- `"none"`: trust no header; `getClientIp` returns `null`. A bare `next start` passes on whatever
  `X-Forwarded-For` the client sent, so there is nothing safe to read without a proxy.
- `"vercel"`: `X-Real-IP`, which Vercel sets to the client's address (its docs list it as
  identical to the `X-Forwarded-For` it overwrites). Only use it on Vercel.
- `"cloudflare"`: `CF-Connecting-IP`. Only safe when your origin accepts traffic from Cloudflare
  alone; otherwise anyone can send the header straight to it.
- `{ header, hops }`: any other header. For a list such as `X-Forwarded-For`, `hops` is how many
  proxies you run in front of the app (default 1): each appends the address it received the
  request from, so the client is `hops` entries from the right. Entries further left were sent
  by the client and can be anything.

## Functions

### createRouteHelpers()

> **createRouteHelpers**\<`TScope`\>(`modules`, `options?`): [`RouteHelpers`](#routehelpers)\<`TScope`\>

Route-handler wrappers bound to your groundwork instance and proxy setup. Create them once:

```ts
// lib/route.ts
export const { withApiKey, withRateLimit, withIdempotency, clientIp } =
  createRouteHelpers(gw, { trustProxy: "vercel" });

// app/api/posts/route.ts
export const POST = withApiKey(["posts:write"], async (request, { apiKey }) => {
  return Response.json(await createPost(apiKey.ownerId, await request.json()), { status: 201 });
});
```

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Parameters

##### modules

[`RouteHelperModules`](#routehelpermodules)\<`TScope`\>

##### options?

[`RouteHelpersOptions`](#routehelpersoptions) = `{}`

#### Returns

[`RouteHelpers`](#routehelpers)\<`TScope`\>

***

### getClientIp()

> **getClientIp**(`input`, `options?`): `string` \| `null`

The client's IP address in canonical form, or `null` when the trusted header is missing or
isn't an address. Never reads a header you didn't choose to trust.

```ts
getClientIp(request, { trustProxy: "vercel" }); // "203.0.113.7"
getClientIp(request, { trustProxy: { header: "x-forwarded-for", hops: 1 } });
```

#### Parameters

##### input

`Request` \| `Headers`

##### options?

[`ClientIpOptions`](#clientipoptions) = `{}`

#### Returns

`string` \| `null`

***

### jobsRoute()

> **jobsRoute**(`modules`, `options`): (`request`) => `Promise`\<`Response`\>

An HTTP trigger for `gw.jobs.runOnce()`, for cron services and serverless hosts where nothing
runs `gw.jobs.work()`. Export it as both GET (what Vercel Cron sends) and POST:

```ts
// app/api/jobs/route.ts
import "@/lib/jobs"; // the file that defines your jobs and schedules
export const maxDuration = 60;
export const GET = jobsRoute(gw, { secret: env.CRON_SECRET });
export const POST = GET;
```

Responds with the run's summary (`{ claimed, completed, retried, failed, scheduled, durationMs }`).
`?schedule=<name>` makes that schedule due first, like `gw.jobs.trigger(name)`.

#### Parameters

##### modules

###### jobs

[`Jobs`](jobs/README.md#jobs)

##### options

[`JobsRouteOptions`](#jobsrouteoptions)

#### Returns

(`request`) => `Promise`\<`Response`\>
