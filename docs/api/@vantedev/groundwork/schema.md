# @vantedev/groundwork/schema

`@vantedev/groundwork/schema`: table factories for your Drizzle schema.

```ts
// db/schema/groundwork.ts
import { groundworkTables } from "@vantedev/groundwork/schema";

export const { rateLimits, auditLog, apiKeys, jobs, jobSchedules, idempotencyKeys } =
  groundworkTables();
```

Export the tables you use from a file drizzle-kit reads, and `drizzle-kit generate` creates the
migration. groundwork never runs DDL itself. Only exported tables are created, so destructure
just the ones you need.

## Interfaces

### GroundworkTablesOptions

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `undefined`

#### Properties

##### prefix?

> `readonly` `optional` **prefix?**: `string`

Prepended to every table and index name. Defaults to `"gw_"`, so groundwork's tables never
clash with yours. Pass `""` for plain names.

##### schema?

> `readonly` `optional` **schema?**: `TSchema`

Postgres schema to create the tables in. Defaults to none, so they land in the connection's
`search_path` (usually `public`). When set, also export the returned `schema` so drizzle-kit
generates `CREATE SCHEMA`.

## Type Aliases

### ApiKeysTable

> **ApiKeysTable**\<`TSchema`\> = `ReturnType`\<*typeof* `buildApiKeysTable`\>

The API-key table, as returned by `groundworkTables()`.

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `string` \| `undefined`

***

### AuditLogTable

> **AuditLogTable**\<`TSchema`\> = `ReturnType`\<*typeof* `buildAuditLogTable`\>

The audit-log table, as returned by `groundworkTables()`.

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `string` \| `undefined`

***

### GroundworkTables

> **GroundworkTables**\<`TSchema`\> = `object` & (`TSchema` *extends* `string` ? `object` : `unknown`)

Every groundwork table. Each module's table is added here as the module lands.

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `undefined`

#### Type Declaration

##### apiKeys

> `readonly` **apiKeys**: [`ApiKeysTable`](#apikeystable)\<`TSchema`\>

##### auditLog

> `readonly` **auditLog**: [`AuditLogTable`](#auditlogtable)\<`TSchema`\>

##### idempotencyKeys

> `readonly` **idempotencyKeys**: [`IdempotencyKeysTable`](#idempotencykeystable)\<`TSchema`\>

##### jobs

> `readonly` **jobs**: [`JobsTable`](#jobstable)\<`TSchema`\>

##### jobSchedules

> `readonly` **jobSchedules**: [`JobSchedulesTable`](#jobschedulestable)\<`TSchema`\>

##### rateLimits

> `readonly` **rateLimits**: [`RateLimitsTable`](#ratelimitstable)\<`TSchema`\>

***

### IdempotencyKeysTable

> **IdempotencyKeysTable**\<`TSchema`\> = `ReturnType`\<*typeof* `buildIdempotencyKeysTable`\>

The idempotency-key table, as returned by `groundworkTables()`.

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `string` \| `undefined`

***

### JobSchedulesTable

> **JobSchedulesTable**\<`TSchema`\> = `ReturnType`\<*typeof* `buildJobSchedulesTable`\>

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `string` \| `undefined`

***

### JobsTable

> **JobsTable**\<`TSchema`\> = `ReturnType`\<*typeof* `buildJobsTable`\>

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `string` \| `undefined`

***

### RateLimitsTable

> **RateLimitsTable**\<`TSchema`\> = `ReturnType`\<*typeof* `buildRateLimitsTable`\>

The rate-limit table, as returned by `groundworkTables()`.

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `string` \| `undefined`

## Variables

### DEFAULT\_PREFIX

> `const` **DEFAULT\_PREFIX**: `"gw_"` = `"gw_"`

The prefix used when none is given.

## Functions

### groundworkTables()

> **groundworkTables**\<`TSchema`\>(`options?`): [`GroundworkTables`](#groundworktables)\<`TSchema`\>

Creates groundwork's tables with one prefix and schema.

```ts
export const { rateLimits } = groundworkTables({ prefix: "gw_" });
export const { schema: groundworkSchema, rateLimits } = groundworkTables({ schema: "ops" });
```

#### Type Parameters

##### TSchema

`TSchema` *extends* `string` \| `undefined` = `undefined`

#### Parameters

##### options?

[`GroundworkTablesOptions`](#groundworktablesoptions)\<`TSchema`\> = `{}`

#### Returns

[`GroundworkTables`](#groundworktables)\<`TSchema`\>
