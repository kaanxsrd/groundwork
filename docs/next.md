# Next.js route helpers

`groundwork/next` wraps App Router route handlers with API-key checks, rate limits and idempotency, gives you a cron route for jobs, and reads the client's IP from the one proxy header you trust. It only uses the Web `Request` and `Response` and never imports `next`, so it also fits any framework with the same handler shape. CI tests it with Next.js 16.

## Setup

Create the helpers once, next to your groundwork instance:

```ts
// lib/groundwork.ts
import { createRouteHelpers } from "groundwork/next";

export const { withApiKey, withRateLimit, withIdempotency, clientIp } = createRouteHelpers(gw, {
  trustProxy: process.env.VERCEL ? "vercel" : "none",
});
```

## `withApiKey(scopes, handler)`

Requires a key with every scope in `scopes`. Failures get the [JSON 401, 403 or 429 from `verify`](api-keys.md), with `WWW-Authenticate` set. The handler gets the key as `context.apiKey`, and the key's rate-limit headers are added to its response:

```ts
export const GET = withApiKey(["posts:read"], async (request, { apiKey, params }) => {
  return Response.json(await listPosts(apiKey.ownerId));
});
```

Scopes are checked against the ones you declared: `withApiKey(["posts:delete"], …)` doesn't compile if there's no `posts:delete`.

Keys with an IP allowlist are checked against `clientIp(request)`. Without a trusted proxy that's `null`, so those keys are refused.

For typed route params, pass your route's context type:

```ts
export const GET = withApiKey<RouteContext<"/posts/[id]">>(["posts:read"], async (_request, { params }) => {
  const { id } = await params;
  return Response.json(await getPost(id));
});
```

## `withRateLimit(rule, key, handler)`

Checks a [rate-limit rule](rate-limiting.md) for the subject `key` returns. Over the limit, it answers `429` with `Retry-After` and `RateLimit` headers and a JSON body (`rate_limited`). Otherwise the handler runs and the headers are added to its response. Return `null` from `key` to let a request through without counting it:

```ts
const signups = gw.rateLimit.rule({ name: "signup:ip", limit: 5, window: "1h" });

export const POST = withRateLimit(signups, (request) => clientIp(request), handleSignup);
```

If there's no trusted proxy, `clientIp` is `null` and that example limits nothing. Behind no proxy at all, limit by something else, such as the user or API key.

## `withIdempotency(options, handler)`

Makes the handler safe to retry with an `Idempotency-Key` header. See [idempotency keys](idempotency.md) for what's stored and the status codes. `scope` can be a function of the request and context:

```ts
withIdempotency({ scope: (_request, { apiKey }) => `apikey:${apiKey.id}`, required: true }, handler);
```

## Composing them

Wrappers nest, and what an outer one adds is typed in the ones inside it:

```ts
export const POST = withApiKey(
  ["posts:write"],
  withRateLimit(
    postWrites,
    (_request, { apiKey }) => apiKey.id,
    withIdempotency({ scope: (_request, { apiKey }) => `apikey:${apiKey.id}` }, createPost),
  ),
);
```

Order matters. Put `withApiKey` outside, so nothing runs for a bad key. Put `withRateLimit` outside `withIdempotency` if replays should count against the limit, as they do above, or inside it if they shouldn't.

## `jobsRoute(gw, { secret, budgetMs, concurrency })`

An HTTP trigger for `gw.jobs.runOnce()`, for serverless hosts where nothing runs `gw.jobs.work()`:

```ts
// app/api/jobs/route.ts
import { jobsRoute } from "groundwork/next";
import { env } from "@/lib/env";
import { gw } from "@/lib/groundwork";
import "@/lib/jobs"; // a worker only runs the job types it knows

export const maxDuration = 60;
export const GET = jobsRoute(gw, { secret: env.CRON_SECRET, budgetMs: 50_000 });
export const POST = GET;
```

- Callers must send `Authorization: Bearer <secret>`. The secret must be at least 16 characters. On Vercel, name it `CRON_SECRET` and [Vercel Cron](https://vercel.com/docs/cron-jobs) sends it. The comparison is timing-safe.
- It answers with the run's summary: `{ claimed, completed, retried, failed, scheduled, durationMs }`.
- `?schedule=<name>` makes that schedule due first, like VaultDrop's `?job=`.
- Keep `budgetMs` under the route's `maxDuration`, leaving time for running jobs to finish.

## `getClientIp(request, { trustProxy })`

The client's IP in canonical form, or `null`. A header is only read when you say a proxy you control sets it:

| `trustProxy` | Reads | Use it |
| --- | --- | --- |
| `"none"` (default) | nothing | Without a proxy. A bare `next start` keeps whatever `X-Forwarded-For` the client sent, so no header is safe to read. |
| `"vercel"` | `X-Real-IP` | On Vercel, which sets it to the client's address. |
| `"cloudflare"` | `CF-Connecting-IP` | Behind Cloudflare, **if** your origin accepts traffic from Cloudflare only. Otherwise anyone can send the header to it directly. |
| `{ header: "x-forwarded-for", hops: 1 }` | the entry `hops` from the right | Behind your own proxies: `hops` is how many there are. Each appends the address it received the request from; the entries further left came from the client and can be anything. |
| `{ header: "fly-client-ip" }` | that header | Any other single-address header your platform sets. |

Ports are dropped and IPv6 is normalised, so `[2001:DB8::1]:443` becomes `2001:db8::1`. `createRouteHelpers` checks `trustProxy` at startup, so a typo throws instead of quietly returning `null`.

## Next.js 16 notes

- With Cache Components (on in new apps), a `GET` handler that reads nothing from the request is prerendered at build. `withApiKey`, `withRateLimit`, `withIdempotency` and `jobsRoute` all read the request, so they always run at request time. For a `GET` route that doesn't, call `await connection()` from `next/server` first.
- Route modules are loaded at build, so `createGroundwork` and `jobsRoute` check their secrets during `next build`. Set the environment for the build too (`.env.local` does this locally).
- groundwork needs the Node.js runtime, the default for route handlers. The edge runtime isn't supported, and `proxy.ts` isn't tested.
