# @vantedev/groundwork/api-keys

`@vantedev/groundwork/api-keys`: scoped API keys stored as HMAC hashes, with rotation, suspension, IP and
origin allowlists, and per-key rate limits and quotas.

```ts
import { createApiKeys } from "@vantedev/groundwork/api-keys";

const apiKeys = createApiKeys({
  db, table: tables.apiKeys, secret, rateLimiter,
  namespace: "vnt",
  scopes: { "posts:read": "Read posts", "posts:write": "Create and edit posts" },
});

const { key } = await apiKeys.create({ name: "CI deploy", scopes: ["posts:write"], expiresIn: "90d" });
const auth = await apiKeys.verify(request, { scopes: ["posts:write"], ip });
if (!auth.ok) return auth.response;
```

## Interfaces

### ApiKeyFilter

#### Properties

##### limit?

> `readonly` `optional` **limit?**: `number`

At most this many keys, newest first. Defaults to 1,000.

##### ownerId?

> `readonly` `optional` **ownerId?**: `string` \| `number`

##### status?

> `readonly` `optional` **status?**: [`ApiKeyStatus`](#apikeystatus) \| readonly [`ApiKeyStatus`](#apikeystatus)[]

***

### ApiKeyPolicyInput

#### Extended by

- [`CreateApiKeyInput`](#createapikeyinput)

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Properties

##### allowedIps?

> `readonly` `optional` **allowedIps?**: readonly `string`[]

IPv4 and IPv6 addresses or CIDR blocks. Empty allows any address.

##### allowedOrigins?

> `readonly` `optional` **allowedOrigins?**: readonly `string`[]

Origins such as `https://app.example.com`. Empty allows any origin.

##### dailyQuota?

> `readonly` `optional` **dailyQuota?**: `number` \| `null`

Requests per day, counted from the first request of each day-long window. `null` for none.

##### description?

> `readonly` `optional` **description?**: `string` \| `null`

##### metadata?

> `readonly` `optional` **metadata?**: `Readonly`\<`Record`\<`string`, `unknown`\>\> \| `null`

Anything else your app keeps with the key.

##### name

> `readonly` **name**: `string`

##### ownerId?

> `readonly` `optional` **ownerId?**: `string` \| `number` \| `null`

##### rateLimit?

> `readonly` `optional` **rateLimit?**: [`ApiKeyRateLimit`](#apikeyratelimit) \| `null`

`null` for no per-key limit. Defaults to the module's `defaultRateLimit`.

##### scopes

> `readonly` **scopes**: readonly [`GrantedScope`](#grantedscope)\<`TScope`\>[]

***

### ApiKeyRateLimit

At most `limit` requests per `window` for one key.

#### Properties

##### limit

> `readonly` **limit**: `number`

##### window

> `readonly` **window**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

***

### ApiKeyRecord

A key as stored, without its hash. Safe to show in a UI or log.

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Properties

##### allowedIps

> `readonly` **allowedIps**: readonly `string`[]

##### allowedOrigins

> `readonly` **allowedOrigins**: readonly `string`[]

##### createdAt

> `readonly` **createdAt**: `Date`

##### createdBy

> `readonly` **createdBy**: `string` \| `null`

##### dailyQuota

> `readonly` **dailyQuota**: `number` \| `null`

##### description

> `readonly` **description**: `string` \| `null`

##### expiresAt

> `readonly` **expiresAt**: `Date` \| `null`

##### id

> `readonly` **id**: `string`

##### lastUsedAt

> `readonly` **lastUsedAt**: `Date` \| `null`

##### lastUsedIp

> `readonly` **lastUsedIp**: `string` \| `null`

##### metadata

> `readonly` **metadata**: `Record`\<`string`, `unknown`\> \| `null`

##### name

> `readonly` **name**: `string`

##### ownerId

> `readonly` **ownerId**: `string` \| `null`

##### prefix

> `readonly` **prefix**: `string`

What to show instead of the key: `vnt_3f9ca0c44a15`.

##### previousKeyExpiresAt

> `readonly` **previousKeyExpiresAt**: `Date` \| `null`

Until when the key from before the last rotation still works.

##### rateLimit

> `readonly` **rateLimit**: [`ApiKeyRateLimit`](#apikeyratelimit) \| `null`

##### revokedAt

> `readonly` **revokedAt**: `Date` \| `null`

##### revokedReason

> `readonly` **revokedReason**: `string` \| `null`

##### rotatedAt

> `readonly` **rotatedAt**: `Date` \| `null`

##### scopes

> `readonly` **scopes**: readonly [`GrantedScope`](#grantedscope)\<`TScope`\>[]

##### status

> `readonly` **status**: [`ApiKeyStatus`](#apikeystatus)

Worked out from the dates below at the time of the read.

##### suspendedReason

> `readonly` **suspendedReason**: `string` \| `null`

##### suspendedUntil

> `readonly` **suspendedUntil**: `Date` \| `null`

##### updatedAt

> `readonly` **updatedAt**: `Date`

***

### ApiKeys

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Properties

##### namespace

> `readonly` **namespace**: `string`

##### scopes

> `readonly` **scopes**: `Readonly`\<`Record`\<`TScope`, `string`\>\>

The declared scopes and their descriptions, for building a UI.

#### Methods

##### create()

> **create**(`input`, `options?`): `Promise`\<\{ `key`: `string`; `record`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>; \}\>

Creates a key. `key` is returned once and never stored: show it to the user now.

###### Parameters

###### input

[`CreateApiKeyInput`](#createapikeyinput)\<`TScope`\>

###### options?

[`MutationOptions`](#mutationoptions)

###### Returns

`Promise`\<\{ `key`: `string`; `record`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>; \}\>

##### delete()

> **delete**(`id`, `options?`): `Promise`\<`boolean`\>

Deletes a revoked key's record. Active keys must be revoked first.

###### Parameters

###### id

`string`

###### options?

[`MutationOptions`](#mutationoptions)

###### Returns

`Promise`\<`boolean`\>

##### get()

> **get**(`id`): `Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

###### Parameters

###### id

`string`

###### Returns

`Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

##### list()

> **list**(`filter?`): `Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>[]\>

###### Parameters

###### filter?

[`ApiKeyFilter`](#apikeyfilter)

###### Returns

`Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>[]\>

##### redactKeys()

> **redactKeys**(`text`): `string`

Replaces any key in `text` with its prefix, for logs and URLs.

###### Parameters

###### text

`string`

###### Returns

`string`

##### reinstate()

> **reinstate**(`id`, `options?`): `Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

Lifts a suspension early.

###### Parameters

###### id

`string`

###### options?

[`MutationOptions`](#mutationoptions)

###### Returns

`Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

##### revoke()

> **revoke**(`id`, `options?`): `Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

Permanent. The key and any rotated-out key stop working at once.

###### Parameters

###### id

`string`

###### options?

[`MutationOptions`](#mutationoptions) & `object`

###### Returns

`Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

##### rotate()

> **rotate**(`id`, `options?`): `Promise`\<\{ `key`: `string`; `record`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>; \} \| `null`\>

Issues a new key for the same record. The old key keeps working for `grace` (default
`"24h"`; `"0s"` ends it at once). Returns `null` for a revoked or unknown key.

###### Parameters

###### id

`string`

###### options?

[`MutationOptions`](#mutationoptions) & `object`

###### Returns

`Promise`\<\{ `key`: `string`; `record`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>; \} \| `null`\>

##### suspend()

> **suspend**(`id`, `options`): `Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

Temporarily blocks the key for `for`, such as `"1h"`.

###### Parameters

###### id

`string`

###### options

[`MutationOptions`](#mutationoptions) & `object`

###### Returns

`Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

##### update()

> **update**(`id`, `patch`, `options?`): `Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

###### Parameters

###### id

`string`

###### patch

[`UpdateApiKeyInput`](#updateapikeyinput)\<`TScope`\>

###### options?

[`MutationOptions`](#mutationoptions)

###### Returns

`Promise`\<[`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`\>

##### verify()

> **verify**(`input`, `options?`): `Promise`\<[`VerifyResult`](#verifyresult)\<`TScope`\>\>

Checks a key from a `Request`, `Headers` (`Authorization: Bearer …` or `X-API-Key`) or a raw
string. A malformed key is rejected without touching the database.

###### Parameters

###### input

`string` \| `Request` \| `Headers` \| `null` \| `undefined`

###### options?

[`VerifyOptions`](#verifyoptions)\<`TScope`\>

###### Returns

`Promise`\<[`VerifyResult`](#verifyresult)\<`TScope`\>\>

***

### ApiKeysOptions

#### Type Parameters

##### TScopes

`TScopes` *extends* `Record`\<`string`, `string`\>

#### Properties

##### checksum?

> `readonly` `optional` **checksum?**: `boolean`

Append a CRC32 checksum to new keys (`true`, the default). Keys without one still verify.

##### clock?

> `readonly` `optional` **clock?**: [`Clock`](../groundwork.md#clock)

Defaults to Postgres's time. Inject one in tests.

##### db

> `readonly` **db**: [`GroundworkDatabase`](../groundwork.md#groundworkdatabase)

##### defaultRateLimit?

> `readonly` `optional` **defaultRateLimit?**: [`ApiKeyRateLimit`](#apikeyratelimit) \| `null`

The limit new keys get when `create()` doesn't set one. Defaults to 60 per minute.

##### legacyHash?

> `readonly` `optional` **legacyHash?**: (`key`) => `string`

For keys created by a previous system: the hash it stored for a key, such as
`(key) => createHmac("sha256", oldPepper).update(key).digest("hex")`. Such keys verify, and
are moved to groundwork's hash the first time they're used.

###### Parameters

###### key

`string`

###### Returns

`string`

##### logger?

> `readonly` `optional` **logger?**: [`Logger`](../groundwork.md#logger-1)

Defaults to `console` (warnings and errors only).

##### namespace

> `readonly` **namespace**: `string`

The start of every key, such as `"vnt"` for `vnt_…`. Pick something unique to your app.

##### onEvent?

> `readonly` `optional` **onEvent?**: (`event`) => `void` \| `Promise`\<`void`\>

Called after every change to a key, in its transaction. `createGroundwork` uses it for the audit log.

###### Parameters

###### event

[`ApiKeyEvent`](#apikeyevent)\<keyof `TScopes` & `string`\>

###### Returns

`void` \| `Promise`\<`void`\>

##### previousSecrets?

> `readonly` `optional` **previousSecrets?**: [`PreviousSecretsSource`](../groundwork.md#previoussecretssource)

Secrets used before `secret`. Keys stored under one of them still verify, and are moved to
`secret` the first time they're used. See "Rotating the secret" in the core-concepts docs.

##### rateLimiter?

> `readonly` `optional` **rateLimiter?**: [`RateLimiter`](rate-limit.md#ratelimiter)

Enforces per-key rate limits and daily quotas. Required unless `defaultRateLimit` is `null`.

##### scopes

> `readonly` **scopes**: `TScopes`

Every scope your API knows, with a description: `{ "posts:read": "Read posts" }`.

##### secret

> `readonly` **secret**: [`SecretSource`](../groundwork.md#secretsource)

The app secret, or a function that returns it on first use. Keys are stored as HMACs under a
subkey derived from it.

##### table

> `readonly` **table**: [`ApiKeysTable`](schema.md#apikeystable)

The `apiKeys` table from `groundworkTables()`.

##### waitUntil?

> `readonly` `optional` **waitUntil?**: (`promise`) => `void`

Receives background writes (`lastUsedAt`) so a serverless platform can wait for them:
Next.js `after`, or `ctx.waitUntil`. Defaults to letting them run on their own.

###### Parameters

###### promise

`Promise`\<`unknown`\>

###### Returns

`void`

***

### CreateApiKeyInput

#### Extends

- [`ApiKeyPolicyInput`](#apikeypolicyinput)\<`TScope`\>

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Properties

##### allowedIps?

> `readonly` `optional` **allowedIps?**: readonly `string`[]

IPv4 and IPv6 addresses or CIDR blocks. Empty allows any address.

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`allowedIps`](#allowedips)

##### allowedOrigins?

> `readonly` `optional` **allowedOrigins?**: readonly `string`[]

Origins such as `https://app.example.com`. Empty allows any origin.

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`allowedOrigins`](#allowedorigins)

##### dailyQuota?

> `readonly` `optional` **dailyQuota?**: `number` \| `null`

Requests per day, counted from the first request of each day-long window. `null` for none.

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`dailyQuota`](#dailyquota)

##### description?

> `readonly` `optional` **description?**: `string` \| `null`

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`description`](#description)

##### expiresAt?

> `readonly` `optional` **expiresAt?**: `Date` \| `null`

Or at this time. Must be in the future.

##### expiresIn?

> `readonly` `optional` **expiresIn?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

Expires this long after creation.

##### metadata?

> `readonly` `optional` **metadata?**: `Readonly`\<`Record`\<`string`, `unknown`\>\> \| `null`

Anything else your app keeps with the key.

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`metadata`](#metadata)

##### name

> `readonly` **name**: `string`

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`name`](#name)

##### ownerId?

> `readonly` `optional` **ownerId?**: `string` \| `number` \| `null`

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`ownerId`](#ownerid-1)

##### rateLimit?

> `readonly` `optional` **rateLimit?**: [`ApiKeyRateLimit`](#apikeyratelimit) \| `null`

`null` for no per-key limit. Defaults to the module's `defaultRateLimit`.

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`rateLimit`](#ratelimit)

##### scopes

> `readonly` **scopes**: readonly [`GrantedScope`](#grantedscope)\<`TScope`\>[]

###### Inherited from

[`ApiKeyPolicyInput`](#apikeypolicyinput).[`scopes`](#scopes)

***

### MutationOptions

#### Properties

##### actor?

> `readonly` `optional` **actor?**: [`AuditActor`](audit.md#auditactor)

Who is doing this, for the audit log. Defaults to `{ type: "system" }`.

##### tx?

> `readonly` `optional` **tx?**: [`GroundworkDatabase`](../groundwork.md#groundworkdatabase)

Run inside this transaction, together with its audit entry.

***

### VerifyOptions

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Properties

##### ip?

> `readonly` `optional` **ip?**: `string` \| `null`

The client's IP, for `allowedIps`. Required for keys that have an allowlist.

##### origin?

> `readonly` `optional` **origin?**: `string` \| `null`

The request's Origin. Defaults to the `Origin` header of the request passed in.

##### scopes?

> `readonly` `optional` **scopes?**: readonly `TScope`[]

Scopes the request needs. All of them must be granted (exactly or by `resource:*`).

## Type Aliases

### ApiKeyAuditAction

> **ApiKeyAuditAction** = *typeof* [`API_KEY_AUDIT_ACTIONS`](#api_key_audit_actions)\[`number`\]

***

### ApiKeyEvent

> **ApiKeyEvent**\<`TScope`\> = `ApiKeyEventBase`\<`TScope`\> & `object` \| `ApiKeyEventBase`\<`TScope`\> & `object` \| `ApiKeyEventBase`\<`TScope`\> & `object` \| `ApiKeyEventBase`\<`TScope`\> & `object`

Passed to `onEvent` after every change to a key. Switch on `type` to read what that change
carries: `before` for an update, `grace` for a rotation, `reason` for a revocation or
suspension. New types may be added in a minor release, so keep a `default` branch.

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

***

### ApiKeyEventType

> **ApiKeyEventType** = `"create"` \| `"update"` \| `"rotate"` \| `"revoke"` \| `"suspend"` \| `"reinstate"` \| `"delete"`

***

### ApiKeyStatus

> **ApiKeyStatus** = `"active"` \| `"suspended"` \| `"expired"` \| `"revoked"`

***

### GrantedScope

> **GrantedScope**\<`TScope`\> = `TScope` \| [`ScopeWildcard`](#scopewildcard)\<`TScope`\>

What a key can be granted: a declared scope, or a wildcard over one resource.

#### Type Parameters

##### TScope

`TScope` *extends* `string`

***

### ScopeWildcard

> **ScopeWildcard**\<`TScope`\> = `TScope` *extends* `` `${infer Resource}:${string}` `` ? `` `${Resource}:*` `` : `never`

`"posts:*"` for a declared `"posts:read"`: every scope of that resource.

#### Type Parameters

##### TScope

`TScope` *extends* `string`

***

### UpdateApiKeyInput

> **UpdateApiKeyInput**\<`TScope`\> = `Partial`\<[`ApiKeyPolicyInput`](#apikeypolicyinput)\<`TScope`\>\> & `object`

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Type Declaration

##### expiresAt?

> `readonly` `optional` **expiresAt?**: `Date` \| `null`

***

### VerifyFailureReason

> **VerifyFailureReason** = `"missing"` \| `"malformed"` \| `"invalid"` \| `"revoked"` \| `"expired"` \| `"suspended"` \| `"forbidden_scope"` \| `"ip_denied"` \| `"origin_denied"` \| `"rate_limited"` \| `"quota_exceeded"`

***

### VerifyResult

> **VerifyResult**\<`TScope`\> = \{ `headers`: `Readonly`\<`Record`\<`string`, `string`\>\>; `key`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>; `ok`: `true`; `quota`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; `rateLimit`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; \} \| \{ `headers`: `Readonly`\<`Record`\<`string`, `string`\>\>; `key`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`; `message`: `string`; `missingScopes`: readonly `TScope`[]; `ok`: `false`; `prefix`: `string` \| `null`; `quota`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; `rateLimit`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; `reason`: [`VerifyFailureReason`](#verifyfailurereason); `response`: `Response`; `status`: `401` \| `403` \| `429`; \}

#### Type Parameters

##### TScope

`TScope` *extends* `string` = `string`

#### Union Members

##### Type Literal

\{ `headers`: `Readonly`\<`Record`\<`string`, `string`\>\>; `key`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>; `ok`: `true`; `quota`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; `rateLimit`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; \}

###### headers

> `readonly` **headers**: `Readonly`\<`Record`\<`string`, `string`\>\>

Rate-limit headers for the response, when the key has a limit.

###### key

> `readonly` **key**: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\>

###### ok

> `readonly` **ok**: `true`

###### quota

> `readonly` **quota**: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`

The daily quota's check, or `null` when the key has none.

###### rateLimit

> `readonly` **rateLimit**: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`

The per-key limit's check (limit, remaining, reset), or `null` when the key has none.

***

##### Type Literal

\{ `headers`: `Readonly`\<`Record`\<`string`, `string`\>\>; `key`: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`; `message`: `string`; `missingScopes`: readonly `TScope`[]; `ok`: `false`; `prefix`: `string` \| `null`; `quota`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; `rateLimit`: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`; `reason`: [`VerifyFailureReason`](#verifyfailurereason); `response`: `Response`; `status`: `401` \| `403` \| `429`; \}

###### headers

> `readonly` **headers**: `Readonly`\<`Record`\<`string`, `string`\>\>

###### key

> `readonly` **key**: [`ApiKeyRecord`](#apikeyrecord)\<`TScope`\> \| `null`

The key, when it was found (revoked, expired, suspended, or denied by its policy).

###### message

> `readonly` **message**: `string`

###### missingScopes

> `readonly` **missingScopes**: readonly `TScope`[]

For `forbidden_scope`: what was missing. Empty for every other reason.

###### ok

> `readonly` **ok**: `false`

###### prefix

> `readonly` **prefix**: `string` \| `null`

The presented key's prefix (`vnt_3f9ca0c44a15`) when it parsed, for logging failed attempts.

###### quota

> `readonly` **quota**: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`

For `quota_exceeded`: the daily quota's check. Otherwise `null`.

###### rateLimit

> `readonly` **rateLimit**: [`RateLimitResult`](rate-limit.md#ratelimitresult) \| `null`

For `rate_limited` and `quota_exceeded`: the per-key limit's check. Otherwise `null`.

###### reason

> `readonly` **reason**: [`VerifyFailureReason`](#verifyfailurereason)

###### response

> `readonly` **response**: `Response`

A ready JSON response: `{ "error": { "code", "message" } }` with the right headers.

###### status

> `readonly` **status**: `401` \| `403` \| `429`

## Variables

### API\_KEY\_AUDIT\_ACTIONS

> `const` **API\_KEY\_AUDIT\_ACTIONS**: readonly \[`"api_key.create"`, `"api_key.update"`, `"api_key.rotate"`, `"api_key.revoke"`, `"api_key.suspend"`, `"api_key.reinstate"`, `"api_key.delete"`\]

The audit actions groundwork records for API keys. `createGroundwork` accepts them for you.

## Functions

### apiKeyAuditEvent()

> **apiKeyAuditEvent**(`event`): [`AuditEvent`](audit.md#auditevent)\<`"api_key.create"` \| `"api_key.update"` \| `"api_key.rotate"` \| `"api_key.revoke"` \| `"api_key.suspend"` \| `"api_key.reinstate"` \| `"api_key.delete"`, `"api_key"`\>

The audit entry for an API-key event. With `createGroundwork` this is recorded for you; on
its own, wire it up yourself:

```ts
createApiKeys({ …, onEvent: (event) => audit.record(apiKeyAuditEvent(event), { tx: event.tx }) });
```

Entries name the key and its prefix, never the key itself.

#### Parameters

##### event

[`ApiKeyEvent`](#apikeyevent)

#### Returns

[`AuditEvent`](audit.md#auditevent)\<`"api_key.create"` \| `"api_key.update"` \| `"api_key.rotate"` \| `"api_key.revoke"` \| `"api_key.suspend"` \| `"api_key.reinstate"` \| `"api_key.delete"`, `"api_key"`\>

***

### createApiKeys()

> **createApiKeys**\<`TScopes`\>(`options`): [`ApiKeys`](#apikeys)\<keyof `TScopes` & `string`\>

Creates scoped API keys stored in your Postgres.

```ts
const apiKeys = createApiKeys({ db, table, secret, namespace: "vnt", scopes: { "posts:read": "Read posts" }, rateLimiter });
const { key } = await apiKeys.create({ name: "CI", scopes: ["posts:read"] });
const auth = await apiKeys.verify(request, { scopes: ["posts:read"] });
if (!auth.ok) return auth.response;
```

#### Type Parameters

##### TScopes

`TScopes` *extends* `Record`\<`string`, `string`\>

#### Parameters

##### options

[`ApiKeysOptions`](#apikeysoptions)\<`TScopes`\>

#### Returns

[`ApiKeys`](#apikeys)\<keyof `TScopes` & `string`\>
