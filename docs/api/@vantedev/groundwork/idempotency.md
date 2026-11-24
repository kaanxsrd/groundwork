# @vantedev/groundwork/idempotency

`@vantedev/groundwork/idempotency`: Idempotency-Key handling with stored responses.

```ts
import { createIdempotency } from "@vantedev/groundwork/idempotency";

const idempotency = createIdempotency({ db, table: idempotencyKeys, secret });

export async function POST(request: Request) {
  return idempotency.handle(request, { scope: `user:${user.id}` }, async () => {
    const order = await createOrder(await request.json());
    return Response.json(order, { status: 201 });
  });
}

// Anything that isn't an HTTP handler, such as a webhook event:
const result = await idempotency.run({ scope: "stripe", key: event.id }, () => fulfil(event));
```

## Interfaces

### HandleOptions

#### Properties

##### fingerprint?

> `readonly` `optional` **fingerprint?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

What identifies the request, instead of its method, path and body. Pass it when you've already
read the body, for example the validated input as JSON.

##### required?

> `readonly` `optional` **required?**: `boolean`

Reject requests without an `Idempotency-Key` header (400). Defaults to `false`: they run unprotected.

##### scope

> `readonly` **scope**: `string`

Whose keys these are, such as `` `apikey:${key.id}` `` or `` `user:${user.id}` ``. Keys never
match across scopes, so one client can't replay another's response.

##### ttl?

> `readonly` `optional` **ttl?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

How long a completed response is replayed. Defaults to the module's `ttl`.

***

### Idempotency

#### Methods

##### cleanup()

> **cleanup**(): `Promise`\<`number`\>

Deletes expired keys. Run it every hour or so; returns how many rows it deleted.

###### Returns

`Promise`\<`number`\>

##### handle()

> **handle**(`request`, `options`, `handler`): `Promise`\<`Response`\>

Makes an HTTP handler safe to retry, following draft-ietf-httpapi-idempotency-key-header:

- no `Idempotency-Key`: runs `handler` (or 400 when `required`);
- a key seen for the first time: runs `handler` and stores a 2xx or 3xx response;
- the same key and request again: replays the stored response with `Idempotent-Replayed: true`;
- the same key with a different request: 422;
- the same key while the first request is still running: 409.

Errors (4xx, 5xx or a throw) are not stored, so the client can retry with the same key. The
request's body is read from a clone, so `handler` can still read it.

###### Parameters

###### request

`Request`

###### options

[`HandleOptions`](#handleoptions)

###### handler

() => `Response` \| `Promise`\<`Response`\>

###### Returns

`Promise`\<`Response`\>

##### run()

> **run**\<`T`\>(`input`, `fn`): `Promise`\<[`RunResult`](#runresult)\<[`Jsonify`](#jsonify)\<`Awaited`\<`T`\>\>\>\>

Runs `fn` at most once per scope and key, and returns its result again on every later call.
For webhooks, server actions and anything else that isn't an HTTP handler, or to store only
part of a response. If `fn` throws, nothing is stored and the next call runs it again.

###### Type Parameters

###### T

`T`

###### Parameters

###### input

[`RunInput`](#runinput)

###### fn

() => `T` \| `Promise`\<`T`\>

###### Returns

`Promise`\<[`RunResult`](#runresult)\<[`Jsonify`](#jsonify)\<`Awaited`\<`T`\>\>\>\>

***

### IdempotencyOptions

#### Properties

##### clock?

> `readonly` `optional` **clock?**: [`Clock`](../groundwork.md#clock)

Defaults to Postgres's `now()`. Inject one in tests.

##### db

> `readonly` **db**: [`GroundworkDatabase`](../groundwork.md#groundworkdatabase)

Your Drizzle Postgres database, from any driver.

##### lease?

> `readonly` `optional` **lease?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

How long a running request holds its key without renewing it. It is renewed every third of
this while the request runs, so this is how soon a crashed request frees its key. Defaults to
`"30s"`.

##### logger?

> `readonly` `optional` **logger?**: [`Logger`](../groundwork.md#logger-1)

Defaults to `console` (warnings and errors only).

##### previousSecrets?

> `readonly` `optional` **previousSecrets?**: [`PreviousSecretsSource`](../groundwork.md#previoussecretssource)

Secrets used before `secret`. A key stored under one of them is still recognised until it
expires, so a retry that straddles a change of secret is replayed, not run again. See
"Rotating the secret" in the core-concepts docs.

##### secret

> `readonly` **secret**: [`SecretSource`](../groundwork.md#secretsource)

The app secret, or a function that returns it on first use. Keys and fingerprints are stored
as HMACs with a subkey derived from it. `cleanup()` never needs it.

##### table

> `readonly` **table**: [`IdempotencyKeysTable`](schema.md#idempotencykeystable)

`idempotencyKeys` from `groundworkTables()`.

##### ttl?

> `readonly` `optional` **ttl?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

How long a completed result is replayed. Defaults to `"24h"`, as Stripe and VaultDrop do.

***

### RunInput

#### Properties

##### fingerprint?

> `readonly` `optional` **fingerprint?**: `string` \| `Uint8Array`\<`ArrayBufferLike`\>

What the key was first used for. When given, a later call with the same key and a different
fingerprint gets `{ ok: false, reason: "mismatch" }`. Defaults to none: any call replays.

##### key

> `readonly` **key**: `string`

The idempotency key: a webhook event id, a client-supplied key… 1 to 255 characters.

##### scope

> `readonly` **scope**: `string`

Whose key it is, such as `"stripe"` for webhook event ids or `` `user:${id}` ``.

##### ttl?

> `readonly` `optional` **ttl?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

How long the result is replayed. Defaults to the module's `ttl`.

## Type Aliases

### IdempotencyErrorCode

> **IdempotencyErrorCode** = `"idempotency_key_missing"` \| `"idempotency_key_invalid"` \| `"idempotency_key_reused"` \| `"idempotency_key_in_use"`

***

### Jsonify

> **Jsonify**\<`T`\> = `unknown` *extends* `T` ? `unknown` : `T` *extends* `object` ? [`Jsonify`](#jsonify)\<`J`\> : `T` *extends* `string` \| `number` \| `boolean` \| `null` ? `T` : `T` *extends* `bigint` ? `never` : `T` *extends* `Dropped` ? `undefined` : `T` *extends* readonly `unknown`[] ? `{ -readonly [K in keyof T]: JsonifyItem<T[K]> }` : `T` *extends* `object` ? `JsonObject`\<`T`\> : `never`

What `T` becomes after a trip through JSON: `Date` becomes `string`, properties that hold
functions, symbols or `undefined` disappear (in arrays they become `null`), and objects with
`toJSON()` become what it returns. `run()` returns this type, because a replayed result is read
back from JSON.

#### Type Parameters

##### T

`T`

***

### RunResult

> **RunResult**\<`T`\> = \{ `ok`: `true`; `replayed`: `boolean`; `value`: `T`; \} \| \{ `ok`: `false`; `reason`: `"mismatch"` \| `"in_progress"`; \}

#### Type Parameters

##### T

`T`

#### Union Members

##### Type Literal

\{ `ok`: `true`; `replayed`: `boolean`; `value`: `T`; \}

###### ok

> `readonly` **ok**: `true`

###### replayed

> `readonly` **replayed**: `boolean`

`true` when this is a stored result and the function did not run.

###### value

> `readonly` **value**: `T`

The function's result, as stored: the same value on the first call and every replay.

***

##### Type Literal

\{ `ok`: `false`; `reason`: `"mismatch"` \| `"in_progress"`; \}

###### ok

> `readonly` **ok**: `false`

###### reason

> `readonly` **reason**: `"mismatch"` \| `"in_progress"`

- `mismatch`: the key was already used with a different fingerprint.
- `in_progress`: the first call with this key is still running.

## Variables

### IDEMPOTENCY\_KEY\_HEADER

> `const` **IDEMPOTENCY\_KEY\_HEADER**: `"Idempotency-Key"` = `"Idempotency-Key"`

The request header, per draft-ietf-httpapi-idempotency-key-header-08.

***

### REPLAYED\_HEADER

> `const` **REPLAYED\_HEADER**: `"Idempotent-Replayed"` = `"Idempotent-Replayed"`

Set on a replayed response. The name Stripe and VaultDrop use.

## Functions

### createIdempotency()

> **createIdempotency**(`options`): [`Idempotency`](#idempotency)

Creates idempotency keys on your Postgres.

```ts
const idempotency = createIdempotency({ db, table: tables.idempotencyKeys, secret });
export async function POST(request: Request) {
  return idempotency.handle(request, { scope: `user:${user.id}` }, async () => {
    const order = await createOrder(await request.json());
    return Response.json(order, { status: 201 });
  });
}
```

#### Parameters

##### options

[`IdempotencyOptions`](#idempotencyoptions)

#### Returns

[`Idempotency`](#idempotency)

***

### parseIdempotencyKey()

> **parseIdempotencyKey**(`value`): `string` \| `null`

Reads an `Idempotency-Key` value. The draft makes it a Structured Field string (`"…"`), and most
clients (Stripe's, VaultDrop's) send it bare, so both are accepted. Returns `null` when the
value isn't a valid key.

#### Parameters

##### value

`string`

#### Returns

`string` \| `null`
