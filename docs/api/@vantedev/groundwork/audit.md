# @vantedev/groundwork/audit

`@vantedev/groundwork/audit`: an append-only audit log in your Postgres, with typed actions, diffs,
redaction and keyset pagination.

```ts
import { createAuditLog, diff } from "@vantedev/groundwork/audit";

const audit = createAuditLog({ db, table: auditLog, actions: ["post.create", "post.update"] });

await db.transaction(async (tx) => {
  const [after] = await tx.update(posts).set(input).where(eq(posts.id, id)).returning();
  await audit.record(
    { actor: { type: "user", id: user.id }, action: "post.update", entity: { type: "post", id }, changes: diff(before, after) },
    { tx },
  );
});
```

## Interfaces

### AuditActor

Who did it. `type` is usually `"user"`, `"api_key"` or `"system"`, but any string works.

#### Properties

##### id?

> `readonly` `optional` **id?**: `string` \| `number` \| `null`

The actor's id in your app. Leave it out for `"system"`.

##### label?

> `readonly` `optional` **label?**: `string` \| `null`

A readable name stored with the entry, such as an email, so the log stays readable after the user is deleted.

##### type

> `readonly` **type**: `string` & `object` \| `"user"` \| `"api_key"` \| `"system"`

***

### AuditEntityRef

What it was done to.

#### Type Parameters

##### TEntity

`TEntity` *extends* `string` = `string`

#### Properties

##### id?

> `readonly` `optional` **id?**: `string` \| `number` \| `null`

##### type

> `readonly` **type**: `TEntity`

***

### AuditEntry

An entry as stored, after redaction.

#### Type Parameters

##### TAction

`TAction` *extends* `string` = `string`

##### TEntity

`TEntity` *extends* `string` = `string`

#### Properties

##### action

> `readonly` **action**: `TAction`

##### actor

> `readonly` **actor**: `object`

###### id

> `readonly` **id**: `string` \| `null`

###### label

> `readonly` **label**: `string` \| `null`

###### type

> `readonly` **type**: `string`

##### changes

> `readonly` **changes**: `Record`\<`string`, `unknown`\> \| `null`

##### entity

> `readonly` **entity**: \{ `id`: `string` \| `null`; `type`: `TEntity`; \} \| `null`

##### id

> `readonly` **id**: `number`

##### ip

> `readonly` **ip**: `string` \| `null`

##### metadata

> `readonly` **metadata**: `Record`\<`string`, `unknown`\> \| `null`

##### occurredAt

> `readonly` **occurredAt**: `Date`

##### requestId

> `readonly` **requestId**: `string` \| `null`

##### summary

> `readonly` **summary**: `string` \| `null`

***

### AuditEvent

#### Type Parameters

##### TAction

`TAction` *extends* `string` = `string`

##### TEntity

`TEntity` *extends* `string` = `string`

#### Properties

##### action

> `readonly` **action**: `TAction`

One of the actions declared in `actions`.

##### actor

> `readonly` **actor**: [`AuditActor`](#auditactor)

##### changes?

> `readonly` `optional` **changes?**: `Readonly`\<`Record`\<`string`, `unknown`\>\> \| `null`

What changed, usually `diff(before, after)`.

##### entity?

> `readonly` `optional` **entity?**: [`AuditEntityRef`](#auditentityref)\<`TEntity`\> \| `null`

##### ip?

> `readonly` `optional` **ip?**: `string` \| `null`

##### metadata?

> `readonly` `optional` **metadata?**: `Readonly`\<`Record`\<`string`, `unknown`\>\> \| `null`

Anything else worth keeping, such as a user agent or a reason.

##### occurredAt?

> `readonly` `optional` **occurredAt?**: `Date`

When it happened. Defaults to the transaction's time (or the injected clock). Use it to import old entries.

##### requestId?

> `readonly` `optional` **requestId?**: `string` \| `null`

##### summary?

> `readonly` `optional` **summary?**: `string` \| `null`

A sentence for people, such as `Updated post "Hello"`. Never put secrets here: it isn't redacted.

***

### AuditFilters

Filters for `query()` and `count()`. All of them are optional and combine with AND.

#### Extended by

- [`AuditQuery`](#auditquery)

#### Type Parameters

##### TAction

`TAction` *extends* `string` = `string`

##### TEntity

`TEntity` *extends* `string` = `string`

#### Properties

##### action?

> `readonly` `optional` **action?**: `OneOrMany`\<`TAction`\>

##### actorId?

> `readonly` `optional` **actorId?**: `string` \| `number`

##### actorType?

> `readonly` `optional` **actorType?**: `OneOrMany`\<`string`\>

##### entity?

> `readonly` `optional` **entity?**: `object`

###### id?

> `readonly` `optional` **id?**: `OneOrMany`\<`string` \| `number`\>

###### type?

> `readonly` `optional` **type?**: `OneOrMany`\<`TEntity`\>

##### from?

> `readonly` `optional` **from?**: `Date`

Entries at or after this time.

##### requestId?

> `readonly` `optional` **requestId?**: `string`

##### search?

> `readonly` `optional` **search?**: `string`

Case-insensitive text search in the summary, the entity id and the actor label.

##### to?

> `readonly` `optional` **to?**: `Date`

Entries before this time.

##### where?

> `readonly` `optional` **where?**: `SQL`\<`unknown`\>

Any extra condition, written with the table's own columns:
`` sql`${auditLog.changes}->>'orderNumber' = ${orderNumber}` ``.

***

### AuditLog

#### Type Parameters

##### TAction

`TAction` *extends* `string` = `string`

##### TEntity

`TEntity` *extends* `string` = `string`

#### Properties

##### actions

> `readonly` **actions**: readonly `TAction`[]

The declared actions.

#### Methods

##### count()

> **count**(`filters?`): `Promise`\<`number`\>

How many entries match, for "1,204 entries" in a UI.

###### Parameters

###### filters?

[`AuditFilters`](#auditfilters)\<`TAction`, `TEntity`\>

###### Returns

`Promise`\<`number`\>

##### prune()

> **prune**(`options`): `Promise`\<`number`\>

Deletes entries older than `olderThan`. The only way groundwork ever removes entries.

###### Parameters

###### options

###### olderThan

`` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

###### Returns

`Promise`\<`number`\>

##### query()

> **query**(`query?`): `Promise`\<[`AuditPage`](#auditpage)\<`TAction`, `TEntity`\>\>

One page of entries, with keyset pagination: no duplicates or skipped rows between pages.

###### Parameters

###### query?

[`AuditQuery`](#auditquery)\<`TAction`, `TEntity`\>

###### Returns

`Promise`\<[`AuditPage`](#auditpage)\<`TAction`, `TEntity`\>\>

##### record()

> **record**(`event`, `options?`): `Promise`\<[`AuditEntry`](#auditentry)\<`TAction`, `TEntity`\>\>

Records one entry and returns it as stored.

###### Parameters

###### event

[`AuditEvent`](#auditevent)\<`TAction`, `TEntity`\>

###### options?

[`RecordOptions`](#recordoptions)

###### Returns

`Promise`\<[`AuditEntry`](#auditentry)\<`TAction`, `TEntity`\>\>

##### recordMany()

> **recordMany**(`events`, `options?`): `Promise`\<[`AuditEntry`](#auditentry)\<`TAction`, `TEntity`\>[]\>

Records up to 1,000 entries in one statement, all or none. Returns them in order.

###### Parameters

###### events

readonly [`AuditEvent`](#auditevent)\<`TAction`, `TEntity`\>[]

###### options?

[`RecordOptions`](#recordoptions)

###### Returns

`Promise`\<[`AuditEntry`](#auditentry)\<`TAction`, `TEntity`\>[]\>

***

### AuditLogOptions

#### Type Parameters

##### TAction

`TAction` *extends* `string`

##### TEntity

`TEntity` *extends* `string`

#### Properties

##### actions

> `readonly` **actions**: readonly `TAction`[]

Every action your app records, such as `["post.create", "post.update"]`. Typed from this list.

##### clock?

> `readonly` `optional` **clock?**: [`Clock`](../groundwork.md#clock)

Time source for `occurredAt` and `prune()`. Defaults to Postgres's transaction time.

##### db

> `readonly` **db**: [`GroundworkDatabase`](../groundwork.md#groundworkdatabase)

Your Drizzle database. Entries go in `table`.

##### entityTypes?

> `readonly` `optional` **entityTypes?**: readonly `TEntity`[]

Entity types, such as `["post", "user"]`. When given, `entity.type` is typed and checked too.

##### redact?

> `readonly` `optional` **redact?**: readonly [`RedactRule`](#redactrule)[]

Keys to replace with `"[redacted]"` anywhere in `changes` and `metadata`. A string matches any
key that contains it, ignoring case, `_` and `-`; a RegExp is tested against the raw key.
Added to `DEFAULT_REDACT` (password, secret, token, apiKey, authorization, cookie…).

##### redactDefaults?

> `readonly` `optional` **redactDefaults?**: `boolean`

Set to `false` to use only your own `redact` rules. Defaults to `true`.

##### table

> `readonly` **table**: [`AuditLogTable`](schema.md#auditlogtable)

The `auditLog` table from `groundworkTables()`.

***

### AuditPage

#### Type Parameters

##### TAction

`TAction` *extends* `string` = `string`

##### TEntity

`TEntity` *extends* `string` = `string`

#### Properties

##### entries

> `readonly` **entries**: [`AuditEntry`](#auditentry)\<`TAction`, `TEntity`\>[]

##### nextCursor

> `readonly` **nextCursor**: `string` \| `null`

Pass it as `cursor` to get the next page. `null` on the last page.

***

### AuditQuery

Filters for `query()` and `count()`. All of them are optional and combine with AND.

#### Extends

- [`AuditFilters`](#auditfilters)\<`TAction`, `TEntity`\>

#### Type Parameters

##### TAction

`TAction` *extends* `string` = `string`

##### TEntity

`TEntity` *extends* `string` = `string`

#### Properties

##### action?

> `readonly` `optional` **action?**: `OneOrMany`\<`TAction`\>

###### Inherited from

[`AuditFilters`](#auditfilters).[`action`](#action-2)

##### actorId?

> `readonly` `optional` **actorId?**: `string` \| `number`

###### Inherited from

[`AuditFilters`](#auditfilters).[`actorId`](#actorid)

##### actorType?

> `readonly` `optional` **actorType?**: `OneOrMany`\<`string`\>

###### Inherited from

[`AuditFilters`](#auditfilters).[`actorType`](#actortype)

##### cursor?

> `readonly` `optional` **cursor?**: `string` \| `null`

The `nextCursor` of the previous page.

##### entity?

> `readonly` `optional` **entity?**: `object`

###### id?

> `readonly` `optional` **id?**: `OneOrMany`\<`string` \| `number`\>

###### type?

> `readonly` `optional` **type?**: `OneOrMany`\<`TEntity`\>

###### Inherited from

[`AuditFilters`](#auditfilters).[`entity`](#entity-2)

##### from?

> `readonly` `optional` **from?**: `Date`

Entries at or after this time.

###### Inherited from

[`AuditFilters`](#auditfilters).[`from`](#from)

##### limit?

> `readonly` `optional` **limit?**: `number`

Entries per page, 1 to 1,000. Defaults to 50.

##### offset?

> `readonly` `optional` **offset?**: `number`

Skips this many entries, for page numbers ("page 7 of 30", with `count()` for the total).
0 to 100,000, and not together with `cursor`. Unlike cursors, offsets can show an entry twice
or skip one while the log grows.

##### order?

> `readonly` `optional` **order?**: `"desc"` \| `"asc"`

Newest first (`"desc"`, the default) or oldest first (`"asc"`).

##### requestId?

> `readonly` `optional` **requestId?**: `string`

###### Inherited from

[`AuditFilters`](#auditfilters).[`requestId`](#requestid-2)

##### search?

> `readonly` `optional` **search?**: `string`

Case-insensitive text search in the summary, the entity id and the actor label.

###### Inherited from

[`AuditFilters`](#auditfilters).[`search`](#search)

##### to?

> `readonly` `optional` **to?**: `Date`

Entries before this time.

###### Inherited from

[`AuditFilters`](#auditfilters).[`to`](#to)

##### where?

> `readonly` `optional` **where?**: `SQL`\<`unknown`\>

Any extra condition, written with the table's own columns:
`` sql`${auditLog.changes}->>'orderNumber' = ${orderNumber}` ``.

###### Inherited from

[`AuditFilters`](#auditfilters).[`where`](#where)

***

### DiffOptions

#### Type Parameters

##### T

`T`

#### Properties

##### ignore?

> `readonly` `optional` **ignore?**: readonly (keyof `T` & `string`)[]

Fields to leave out even if they changed, such as `"updatedAt"`.

***

### RecordOptions

#### Properties

##### tx?

> `readonly` `optional` **tx?**: [`GroundworkDatabase`](../groundwork.md#groundworkdatabase)

Record inside this transaction, so the entry commits or rolls back with your change.

## Type Aliases

### AuditData

> **AuditData** = `Readonly`\<`Record`\<`string`, `unknown`\>\>

A JSON object stored with an entry. Configured keys are redacted at any depth.

***

### AuditDiff

> **AuditDiff**\<`T`\> = \{ \[K in keyof T\]?: \[T\[K\] \| null, T\[K\] \| null\] \}

`{ field: [before, after] }` for each field that changed. A missing side is `null`.

#### Type Parameters

##### T

`T`

***

### RedactRule

> **RedactRule** = `string` \| `RegExp`

## Variables

### DEFAULT\_REDACT

> `const` **DEFAULT\_REDACT**: readonly `string`[]

Redacted by default, wherever they appear in `changes` or `metadata`. A key matches when it
contains one of these words, ignoring case, `_` and `-`: `accessToken`, `refresh_token` and
`X-Api-Key` all match.

***

### REDACTED

> `const` **REDACTED**: `"[redacted]"` = `"[redacted]"`

What a redacted value is replaced with.

## Functions

### createAuditLog()

> **createAuditLog**\<`TAction`, `TEntity`\>(`options`): [`AuditLog`](#auditlog)\<`TAction`, `TEntity`\>

Creates an append-only audit log in your Postgres.

```ts
const audit = createAuditLog({ db, table: auditLog, actions: ["post.create", "post.update"] });
await audit.record({ actor: { type: "user", id: user.id }, action: "post.update", changes: diff(before, after) }, { tx });
```

#### Type Parameters

##### TAction

`TAction` *extends* `string`

##### TEntity

`TEntity` *extends* `string` = `string`

#### Parameters

##### options

[`AuditLogOptions`](#auditlogoptions)\<`TAction`, `TEntity`\>

#### Returns

[`AuditLog`](#auditlog)\<`TAction`, `TEntity`\>

***

### diff()

> **diff**\<`T`\>(`before`, `after`, `options?`): [`AuditDiff`](#auditdiff)\<`T`\>

The fields that differ between two versions of a row, as `{ field: [before, after] }`.
Nested values are compared deeply, but reported whole. Pass `null` as `before` for a create,
or as `after` for a delete.

```ts
diff({ title: "Old", body: "x" }, { title: "New", body: "x" }); // { title: ["Old", "New"] }
```

#### Type Parameters

##### T

`T` *extends* `object`

#### Parameters

##### before

`T` \| `null` \| `undefined`

##### after

`T` \| `null` \| `undefined`

##### options?

[`DiffOptions`](#diffoptions)\<`T`\> = `{}`

#### Returns

[`AuditDiff`](#auditdiff)\<`T`\>
