# Idempotency keys

Make a write safe to retry. A client sends an `Idempotency-Key` header with a request; if the connection drops and it sends the same request again, it gets the first response back instead of a second order, payment or post. Keys live in a table in your Drizzle schema, and only their hashes are stored.

It follows [draft-ietf-httpapi-idempotency-key-header-08](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/):

| The request | The response |
| --- | --- |
| A key seen for the first time | The handler runs; a 2xx or 3xx response is stored. |
| The same key and the same request again | The stored response, with `Idempotent-Replayed: true`. |
| The same key with a different body, path or method | `422`, `idempotency_key_reused`. |
| The same key while the first request is still running | `409`, `idempotency_key_in_use`, with `Retry-After: 1`. |
| No key, on a route with `required: true` | `400`, `idempotency_key_missing`. |
| A malformed key | `400`, `idempotency_key_invalid`. |

## Quickstart

1. Export the table and generate a migration ([table factories](schema.md)):

   ```ts
   export const { idempotencyKeys } = groundworkTables();
   ```

2. Wrap the handler. With [`@vantedev/groundwork/next`](next.md):

   ```ts
   export const POST = withApiKey(
     ["orders:write"],
     withIdempotency(
       { scope: (_request, { apiKey }) => `apikey:${apiKey.id}` },
       async (request) => Response.json(await createOrder(await request.json()), { status: 201 }),
     ),
   );
   ```

   Or anywhere you have a `Request`:

   ```ts
   return gw.idempotency.handle(request, { scope: `user:${user.id}` }, async () => {
     const order = await createOrder(await request.json());
     return Response.json(order, { status: 201 });
   });
   ```

3. Clients send a fresh key with each operation, and the same key when they retry it:

   ```sh
   curl -X POST https://api.example.com/orders -H "Idempotency-Key: $(uuidgen)" -d '{"sku":"A1"}'
   ```

`createGroundwork` deletes expired keys every hour through a [schedule](jobs.md#schedules), once you use `gw.jobs`. Without jobs, call `gw.idempotency.cleanup()` from your own cron.

## Scopes

`scope` says whose keys these are: `apikey:${key.id}`, `user:${user.id}`, `tenant:${id}`. It's required, because without it two clients that happen to pick the same key would get each other's responses. A key in one scope never matches the same key in another.

Anonymous requests have no good scope. VaultDrop simply rejects an `Idempotency-Key` from anonymous callers; do the same unless you have something stable to scope by.

## What counts as the same request

By default the fingerprint is the method, the path with its query string, and the body bytes. They're hashed with a key derived from your secret, so the stored fingerprint reveals nothing about the body. A different body under the same key is a `422`, as the draft asks.

The body is read from a clone, so the handler can still read it. If you've already read and validated it, pass `fingerprint` with what identifies the request instead. Then two bodies that differ only in whitespace or key order count as the same request:

```ts
const input = OrderSchema.parse(await request.json());
return gw.idempotency.handle(
  request,
  { scope, fingerprint: JSON.stringify(input) },
  async () => Response.json(await createOrder(input), { status: 201 }),
);
```

## What is stored, and for how long

- **Successes only.** 2xx and 3xx responses are stored with their status, headers and body. A 4xx, a 5xx or a thrown error frees the key, so the client can fix the request or retry it with the same key.
- **Not cookies or per-request headers.** `Set-Cookie` is never stored: the first response keeps it, replays don't have it. Neither are `Date`, `Content-Length`, the `RateLimit` headers or `Retry-After`.
- **The body as is.** Text stays text, and anything else is stored as base64. Responses are buffered to store them, so this isn't for streaming responses.
- **For 24 hours** after the response, like Stripe. Change it with `idempotency: { ttl: "48h" }`, or per route with `ttl`. After that, the key is new again.

Stored responses are kept in plain text for the TTL. Don't make a route that returns a secret (a new API key, a one-time token) idempotent this way. Use `run()` and store only what's safe, as below.

## Crashes and long requests

While the first request runs, it holds the key with a lease (default `"30s"`), renewed every third of that. If the process crashes, the lease runs out and the next retry with the same request runs the handler again. If the first request does finish late, its response still goes out, but it can't overwrite what the retry stored.

The one gap: a process that crashes after your transaction commits but before the response is stored. A retry then runs the handler again. Keep handlers transactional and their side effects idempotent (jobs enqueued with `dedupeKey`, for example), as for any at-least-once system.

## Without HTTP: `run()`

`run()` does the same for anything that isn't a route handler: webhook events, server actions, scripts. It runs the function once per scope and key, stores its result as JSON, and returns that result on every later call:

```ts
const result = await gw.idempotency.run({ scope: "stripe", key: event.id }, async () => {
  await fulfilOrder(event.data.object);
  return { fulfilledAt: new Date() };
});
if (!result.ok) return new Response(null, { status: 409 }); // "in_progress" or "mismatch"
result.value.fulfilledAt; // a string: the stored JSON, on the first call too
result.replayed; // true when the function didn't run
```

The result type says what JSON gives back: a `Date` is typed as a `string`. Pass `fingerprint` to have reuse for something else reported as `{ ok: false, reason: "mismatch" }`.

Inside a generic helper, TypeScript can't work out what JSON makes of a type parameter, so `result.value` won't be assignable back to `T`. If you know `T` only holds strings, numbers, booleans, arrays and plain objects, it comes back unchanged. Cast it once, in the helper:

```ts
async function once<T extends Record<string, string | number>>(key: string, fn: () => Promise<T>) {
  const result = await gw.idempotency.run({ scope: "jobs", key }, fn);
  if (!result.ok) throw new Error(result.reason);
  return result.value as unknown as T; // T is JSON already: nothing changes on the round trip
}
```

`run()` is also how you store less than the response. VaultDrop stores only a new secret's id and expiry, and works out the receipt token, a credential, again on each replay:

```ts
const result = await gw.idempotency.run({ scope, key, fingerprint: body }, async () => {
  const secret = await createSecret(input);
  return { id: secret.id, expiresAt: secret.expiresAt.toISOString() };
});
if (!result.ok) return conflict(result.reason);
return Response.json(
  { ...result.value, receiptToken: receiptTokenFor(result.value.id) },
  { status: 201, headers: result.replayed ? { "Idempotent-Replayed": "true" } : {} },
);
```

## Options

```ts
createGroundwork({ …, idempotency: { ttl: "24h", lease: "30s" } });
// or on its own:
createIdempotency({ db, table: idempotencyKeys, secret, ttl, lease, clock, logger });
```

| Option | Default | |
| --- | --- | --- |
| `ttl` | `"24h"` | How long a completed result is replayed. |
| `lease` | `"30s"` | How soon a crashed request frees its key. Renewed while the request runs. |

`handle(request, options, handler)` takes `scope`, `required` (default `false`), `ttl` and `fingerprint`.

## Keys

Keys must be 8 to 255 visible ASCII characters. The draft makes the header a Structured Field string (`Idempotency-Key: "8e03…"`); most clients send it bare (`Idempotency-Key: 8e03…`). Both work.

## Replacing VaultDrop's `withIdempotency`

VaultDrop's `idempotency_keys` table has the same shape: scope, key, a body hash and the stored response. groundwork's version:

- **hashes the key and scope** with a subkey of your secret, and keys the fingerprint too;
- **frees a crashed request's key** after a lease, where VaultDrop's stays "in progress" until it's purged a day later;
- **follows the draft's status codes**, and returns ready responses;
- **adds `run()`**, for VaultDrop's pattern of storing a subset and deriving the rest.

Existing rows can't be carried over, because the keys are hashed differently. Deploy, and let the old table's last day of keys expire.
