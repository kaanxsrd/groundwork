# @vantedev/groundwork/jobs

`@vantedev/groundwork/jobs`: background jobs and schedules on Postgres, enqueued inside your
transactions, with leases, retries with jittered backoff, timeouts and health checks.

```ts
import { createJobs } from "@vantedev/groundwork/jobs";

const jobs = createJobs({ db, table: tables.jobs, schedulesTable: tables.jobSchedules });

export const sendReceipt = jobs.define("email.receipt", {
  schema: z.object({ orderId: z.string() }),
  maxAttempts: 5,
  async run({ orderId }, { signal }) { await mailer.sendReceipt(orderId, { signal }); },
});

await db.transaction(async (tx) => {
  await tx.insert(orders).values(order);
  await sendReceipt.enqueue({ orderId: order.id }, { tx, dedupeKey: `receipt:${order.id}` });
});

jobs.schedule("reports.nightly", { every: "1d" }, () => buildReports());
await jobs.work({ concurrency: 4, signal });
```

## Namespaces

- [StandardSchemaV1](namespaces/StandardSchemaV1.md)

## Interfaces

### EnqueueManyItem

One job for `enqueueMany`: its payload, and `enqueue`'s options except `tx` and `replace`.

#### Extends

- `Omit`\<[`EnqueueOptions`](#enqueueoptions), `"tx"` \| `"replace"`\>

#### Type Parameters

##### TInput

`TInput`

#### Properties

##### dedupeKey?

> `readonly` `optional` **dedupeKey?**: `string`

While a job of this type with this key is pending or running, enqueueing it again does nothing.

###### Inherited from

[`EnqueueOptions`](#enqueueoptions).[`dedupeKey`](#dedupekey-1)

##### delay?

> `readonly` `optional` **delay?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

Not before this long from now.

###### Inherited from

[`EnqueueOptions`](#enqueueoptions).[`delay`](#delay-1)

##### maxAttempts?

> `readonly` `optional` **maxAttempts?**: `number`

Overrides the type's `maxAttempts`.

###### Inherited from

[`EnqueueOptions`](#enqueueoptions).[`maxAttempts`](#maxattempts-1)

##### payload

> `readonly` **payload**: `TInput`

##### priority?

> `readonly` `optional` **priority?**: `number`

Overrides the type's priority.

###### Inherited from

[`EnqueueOptions`](#enqueueoptions).[`priority`](#priority-1)

##### runAt?

> `readonly` `optional` **runAt?**: `Date`

Not before this time.

###### Inherited from

[`EnqueueOptions`](#enqueueoptions).[`runAt`](#runat-1)

***

### EnqueueManyOptions

#### Properties

##### tx?

> `readonly` `optional` **tx?**: [`GroundworkDatabase`](../../groundwork.md#groundworkdatabase)

Enqueue inside this transaction: the jobs only exist if it commits.

***

### EnqueueOptions

#### Properties

##### dedupeKey?

> `readonly` `optional` **dedupeKey?**: `string`

While a job of this type with this key is pending or running, enqueueing it again does nothing.

##### delay?

> `readonly` `optional` **delay?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

Not before this long from now.

##### maxAttempts?

> `readonly` `optional` **maxAttempts?**: `number`

Overrides the type's `maxAttempts`.

##### priority?

> `readonly` `optional` **priority?**: `number`

Overrides the type's priority.

##### replace?

> `readonly` `optional` **replace?**: `boolean`

With `dedupeKey`, to debounce: instead of keeping the pending job with this key, give it this
call's payload, timing and priority, and this call's `maxAttempts` on top of the attempts it
has used. If that job is already running, it finishes without the key and isn't retried, and
this one is enqueued as a new job, so the latest payload always runs. `created` is `false`
when a job was replaced.

##### runAt?

> `readonly` `optional` **runAt?**: `Date`

Not before this time.

##### tx?

> `readonly` `optional` **tx?**: [`GroundworkDatabase`](../../groundwork.md#groundworkdatabase)

Enqueue inside this transaction: the job only exists if it commits.

***

### EnqueueResult

#### Properties

##### created

> `readonly` **created**: `boolean`

`false` when `dedupeKey` matched a job that is already pending or running; `id` is that job.

##### id

> `readonly` **id**: `string`

***

### JobContext

What a handler gets besides its payload.

#### Extended by

- [`ScheduleContext`](#schedulecontext)

#### Properties

##### attempt

> `readonly` **attempt**: `number`

1 on the first try.

##### createdAt

> `readonly` **createdAt**: `Date`

##### id

> `readonly` **id**: `string`

##### maxAttempts

> `readonly` **maxAttempts**: `number`

##### signal

> `readonly` **signal**: `AbortSignal`

Aborted when the job's `timeout` passes, or if this worker loses the job's lease. Pass it to
`fetch` and database calls so a stuck job stops instead of running on in the background.

##### type

> `readonly` **type**: `string`

***

### JobDefinition

#### Extends

- `JobOptions`

#### Type Parameters

##### TPayload

`TPayload`

#### Properties

##### backoff?

> `readonly` `optional` **backoff?**: [`BackoffOptions`](#backoffoptions)

###### Inherited from

`JobOptions.backoff`

##### maxAttempts?

> `readonly` `optional` **maxAttempts?**: `number`

Tries before the job fails for good. Defaults to 5.

###### Inherited from

`JobOptions.maxAttempts`

##### priority?

> `readonly` `optional` **priority?**: `number`

Higher runs first. Defaults to 0.

###### Inherited from

`JobOptions.priority`

##### schema?

> `readonly` `optional` **schema?**: `undefined`

##### timeout?

> `readonly` `optional` **timeout?**: `false` \| `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

Abort the handler after this long. Defaults to `"5m"`; `false` for none.

###### Inherited from

`JobOptions.timeout`

#### Methods

##### onExhausted()?

> `optional` **onExhausted**(`payload`, `failure`, `context`): `unknown`

###### Parameters

###### payload

`TPayload`

###### failure

[`JobFailure`](#jobfailure)

###### context

[`JobContext`](#jobcontext)

###### Returns

`unknown`

##### run()

> **run**(`payload`, `context`): `unknown`

Annotate `payload` to type `enqueue`: `run(payload: { orderId: string }) {…}`.

###### Parameters

###### payload

`TPayload`

###### context

[`JobContext`](#jobcontext)

###### Returns

`unknown`

***

### JobDefinitionWithSchema

#### Extends

- `JobOptions`

#### Type Parameters

##### TSchema

`TSchema` *extends* [`StandardSchemaV1`](#standardschemav1)

#### Properties

##### backoff?

> `readonly` `optional` **backoff?**: [`BackoffOptions`](#backoffoptions)

###### Inherited from

`JobOptions.backoff`

##### maxAttempts?

> `readonly` `optional` **maxAttempts?**: `number`

Tries before the job fails for good. Defaults to 5.

###### Inherited from

`JobOptions.maxAttempts`

##### priority?

> `readonly` `optional` **priority?**: `number`

Higher runs first. Defaults to 0.

###### Inherited from

`JobOptions.priority`

##### schema

> `readonly` **schema**: `TSchema`

Any Standard Schema (zod, valibot, arktype…). Checked on enqueue and again before running.

##### timeout?

> `readonly` `optional` **timeout?**: `false` \| `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

Abort the handler after this long. Defaults to `"5m"`; `false` for none.

###### Inherited from

`JobOptions.timeout`

#### Methods

##### onExhausted()?

> `optional` **onExhausted**(`payload`, `failure`, `context`): `unknown`

Called once when the last attempt fails, for example to mark a notification as failed.

###### Parameters

###### payload

[`InferOutput`](namespaces/StandardSchemaV1.md#inferoutput)\<`TSchema`\>

###### failure

[`JobFailure`](#jobfailure)

###### context

[`JobContext`](#jobcontext)

###### Returns

`unknown`

##### run()

> **run**(`payload`, `context`): `unknown`

###### Parameters

###### payload

[`InferOutput`](namespaces/StandardSchemaV1.md#inferoutput)\<`TSchema`\>

###### context

[`JobContext`](#jobcontext)

###### Returns

`unknown`

***

### JobFailure

Why a job failed for good, passed to `onExhausted`. Never includes the payload.

#### Properties

##### attempt

> `readonly` **attempt**: `number`

##### message

> `readonly` **message**: `string`

##### name

> `readonly` **name**: `string`

***

### JobHandle

#### Type Parameters

##### TType

`TType` *extends* `string`

##### TInput

`TInput`

#### Properties

##### type

> `readonly` **type**: `TType`

#### Methods

##### enqueue()

> **enqueue**(`payload`, `options?`): `Promise`\<[`EnqueueResult`](#enqueueresult)\>

###### Parameters

###### payload

`TInput`

###### options?

[`EnqueueOptions`](#enqueueoptions)

###### Returns

`Promise`\<[`EnqueueResult`](#enqueueresult)\>

##### enqueueMany()

> **enqueueMany**(`jobs`, `options?`): `Promise`\<[`EnqueueResult`](#enqueueresult)[]\>

Enqueues up to 1,000 jobs of this type in one statement, each with its own options. Every
job is checked first, so one bad job enqueues none. Results are in the same order as the
jobs. A `dedupeKey` works as it does for `enqueue`, also between jobs in the same call: the
first one is created, and the others return its id.

###### Parameters

###### jobs

readonly [`EnqueueManyItem`](#enqueuemanyitem)\<`TInput`\>[]

###### options?

[`EnqueueManyOptions`](#enqueuemanyoptions)

###### Returns

`Promise`\<[`EnqueueResult`](#enqueueresult)[]\>

***

### JobListFilter

#### Properties

##### limit?

> `readonly` `optional` **limit?**: `number`

Newest first, at most this many. Defaults to 100, at most 1,000.

##### schedule?

> `readonly` `optional` **schedule?**: `string` \| readonly `string`[]

Runs of these schedules, by name. Combines with `type` like any other filter (AND).

##### since?

> `readonly` `optional` **since?**: `Date`

Created at or after this time.

##### status?

> `readonly` `optional` **status?**: [`JobStatus`](#jobstatus) \| readonly [`JobStatus`](#jobstatus)[]

##### type?

> `readonly` `optional` **type?**: `string` \| readonly `string`[]

***

### JobRecord

#### Properties

##### attempts

> `readonly` **attempts**: `number`

##### completedAt

> `readonly` **completedAt**: `Date` \| `null`

##### createdAt

> `readonly` **createdAt**: `Date`

##### dedupeKey

> `readonly` **dedupeKey**: `string` \| `null`

##### id

> `readonly` **id**: `string`

##### lastError

> `readonly` **lastError**: `string` \| `null`

##### lockedBy

> `readonly` **lockedBy**: `string` \| `null`

##### lockedUntil

> `readonly` **lockedUntil**: `Date` \| `null`

##### maxAttempts

> `readonly` **maxAttempts**: `number`

##### payload

> `readonly` **payload**: `unknown`

##### priority

> `readonly` **priority**: `number`

##### result

> `readonly` **result**: `unknown`

What the handler returned, as JSON.

##### runAt

> `readonly` **runAt**: `Date`

When it is due. While running: when its lease ends.

##### schedule

> `readonly` **schedule**: `string` \| `null`

For a schedule's run, the schedule's name (its `type` is `schedule:<name>`). Otherwise `null`.

##### startedAt

> `readonly` **startedAt**: `Date` \| `null`

##### status

> `readonly` **status**: [`JobStatus`](#jobstatus)

##### type

> `readonly` **type**: `string`

##### updatedAt

> `readonly` **updatedAt**: `Date`

***

### Jobs

#### Methods

##### cancel()

> **cancel**(`id`): `Promise`\<`boolean`\>

Cancels a pending job. A running job can't be cancelled.

###### Parameters

###### id

`string`

###### Returns

`Promise`\<`boolean`\>

##### define()

###### Call Signature

> **define**\<`TType`, `TSchema`\>(`type`, `definition`): [`JobHandle`](#jobhandle)\<`TType`, [`InferInput`](namespaces/StandardSchemaV1.md#inferinput)\<`TSchema`\>\>

Defines a job type and returns a typed handle to enqueue it. Define each type once, at module scope.

###### Type Parameters

###### TType

`TType` *extends* `string`

###### TSchema

`TSchema` *extends* [`StandardSchemaV1`](#standardschemav1)\<`unknown`, `unknown`\>

###### Parameters

###### type

`TType`

###### definition

[`JobDefinitionWithSchema`](#jobdefinitionwithschema)\<`TSchema`\>

###### Returns

[`JobHandle`](#jobhandle)\<`TType`, [`InferInput`](namespaces/StandardSchemaV1.md#inferinput)\<`TSchema`\>\>

###### Call Signature

> **define**\<`TType`, `TPayload`\>(`type`, `definition`): [`JobHandle`](#jobhandle)\<`TType`, `TPayload`\>

###### Type Parameters

###### TType

`TType` *extends* `string`

###### TPayload

`TPayload` = `unknown`

###### Parameters

###### type

`TType`

###### definition

[`JobDefinition`](#jobdefinition)\<`TPayload`\>

###### Returns

[`JobHandle`](#jobhandle)\<`TType`, `TPayload`\>

##### get()

> **get**(`id`): `Promise`\<[`JobRecord`](#jobrecord) \| `null`\>

###### Parameters

###### id

`string`

###### Returns

`Promise`\<[`JobRecord`](#jobrecord) \| `null`\>

##### health()

> **health**(): `Promise`\<[`JobsHealth`](#jobshealth-1)\>

###### Returns

`Promise`\<[`JobsHealth`](#jobshealth-1)\>

##### list()

> **list**(`filter?`): `Promise`\<[`JobRecord`](#jobrecord)[]\>

###### Parameters

###### filter?

[`JobListFilter`](#joblistfilter)

###### Returns

`Promise`\<[`JobRecord`](#jobrecord)[]\>

##### prune()

> **prune**(`options`): `Promise`\<`number`\>

Deletes finished jobs. The only way groundwork removes jobs.

###### Parameters

###### options

###### completedOlderThan

`` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

###### failedOlderThan?

`` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

Defaults to `completedOlderThan`.

###### Returns

`Promise`\<`number`\>

##### retry()

> **retry**(`id`): `Promise`\<`boolean`\>

Runs a failed or cancelled job again from attempt 1.

###### Parameters

###### id

`string`

###### Returns

`Promise`\<`boolean`\>

##### runOnce()

> **runOnce**(`options?`): `Promise`\<[`RunSummary`](#runsummary)\>

Runs due jobs and schedules until none are left or `budgetMs` runs out. For cron and HTTP triggers.

###### Parameters

###### options?

[`RunOnceOptions`](#runonceoptions)

###### Returns

`Promise`\<[`RunSummary`](#runsummary)\>

##### schedule()

> **schedule**(`name`, `options`, `run`): `void`

Runs `run` every `every`, once per tick across all instances, as a job (with retries and history).

###### Parameters

###### name

`string`

###### options

[`ScheduleOptions`](#scheduleoptions)

###### run

(`context`) => `unknown`

###### Returns

`void`

##### trigger()

> **trigger**(`name`): `Promise`\<`boolean`\>

Makes a schedule due now. Returns `false` if it isn't defined.

###### Parameters

###### name

`string`

###### Returns

`Promise`\<`boolean`\>

##### work()

> **work**(`options?`): `Promise`\<[`RunSummary`](#runsummary)\>

The long-running worker. Resolves after `signal` aborts and running jobs finish.

###### Parameters

###### options?

[`WorkOptions`](#workoptions)

###### Returns

`Promise`\<[`RunSummary`](#runsummary)\>

***

### JobsHealth

#### Properties

##### schedules

> `readonly` **schedules**: [`ScheduleHealth`](#schedulehealth)[]

##### types

> `readonly` **types**: [`JobTypeHealth`](#jobtypehealth)[]

***

### JobsOptions

#### Properties

##### clock?

> `readonly` `optional` **clock?**: [`Clock`](../../groundwork.md#clock)

Defaults to Postgres's time. Inject one in tests.

##### db

> `readonly` **db**: [`GroundworkDatabase`](../../groundwork.md#groundworkdatabase)

##### lease?

> `readonly` `optional` **lease?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

How long a claimed job is reserved for its worker. Workers renew it while the job runs, so a
job is only picked up again if its worker stops (a crash, a kill, a lost connection). Defaults
to `"1m"`.

##### logger?

> `readonly` `optional` **logger?**: [`Logger`](../../groundwork.md#logger-1)

Defaults to `console` (warnings and errors only).

##### random?

> `readonly` `optional` **random?**: () => `number`

For tests: the random source for backoff jitter. Defaults to `Math.random`.

###### Returns

`number`

##### schedulesTable

> `readonly` **schedulesTable**: [`JobSchedulesTable`](../schema.md#jobschedulestable)

The `jobSchedules` table from `groundworkTables()`.

##### table

> `readonly` **table**: [`JobsTable`](../schema.md#jobstable)

The `jobs` table from `groundworkTables()`.

##### workerId?

> `readonly` `optional` **workerId?**: `string`

Identifies this worker in `locked_by`. Defaults to `<hostname>:<pid>:<random>`.

***

### JobTypeHealth

#### Properties

##### failedLast24h

> `readonly` **failedLast24h**: `number`

##### lastSuccessAt

> `readonly` **lastSuccessAt**: `Date` \| `null`

##### oldestPendingAgeMs

> `readonly` **oldestPendingAgeMs**: `number` \| `null`

How long the oldest due job has been waiting, or `null` if none is due.

##### pending

> `readonly` **pending**: `number`

##### running

> `readonly` **running**: `number`

##### type

> `readonly` **type**: `string`

***

### RunOnceOptions

#### Properties

##### budgetMs?

> `readonly` `optional` **budgetMs?**: `number`

Stop claiming new jobs after this many milliseconds. Jobs already running finish. Defaults to 10,000.

##### concurrency?

> `readonly` `optional` **concurrency?**: `number`

Jobs at once. Defaults to 4.

***

### RunSummary

#### Properties

##### claimed

> `readonly` **claimed**: `number`

##### completed

> `readonly` **completed**: `number`

##### durationMs

> `readonly` **durationMs**: `number`

##### failed

> `readonly` **failed**: `number`

Failed for good.

##### retried

> `readonly` **retried**: `number`

Failed and scheduled to try again.

##### scheduled

> `readonly` **scheduled**: `number`

Schedule ticks this call enqueued.

***

### ScheduleContext

What a handler gets besides its payload.

#### Extends

- [`JobContext`](#jobcontext)

#### Properties

##### attempt

> `readonly` **attempt**: `number`

1 on the first try.

###### Inherited from

[`JobContext`](#jobcontext).[`attempt`](#attempt)

##### createdAt

> `readonly` **createdAt**: `Date`

###### Inherited from

[`JobContext`](#jobcontext).[`createdAt`](#createdat)

##### id

> `readonly` **id**: `string`

###### Inherited from

[`JobContext`](#jobcontext).[`id`](#id-1)

##### maxAttempts

> `readonly` **maxAttempts**: `number`

###### Inherited from

[`JobContext`](#jobcontext).[`maxAttempts`](#maxattempts-2)

##### scheduledAt

> `readonly` **scheduledAt**: `Date`

When this tick was claimed.

##### signal

> `readonly` **signal**: `AbortSignal`

Aborted when the job's `timeout` passes, or if this worker loses the job's lease. Pass it to
`fetch` and database calls so a stuck job stops instead of running on in the background.

###### Inherited from

[`JobContext`](#jobcontext).[`signal`](#signal)

##### type

> `readonly` **type**: `string`

###### Inherited from

[`JobContext`](#jobcontext).[`type`](#type)

***

### ScheduleHealth

#### Properties

##### every

> `readonly` **every**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

##### healthy

> `readonly` **healthy**: `boolean`

Succeeded within three intervals.

##### lastError

> `readonly` **lastError**: `string` \| `null`

##### lastFailureAt

> `readonly` **lastFailureAt**: `Date` \| `null`

##### lastRunAt

> `readonly` **lastRunAt**: `Date` \| `null`

##### lastSuccessAt

> `readonly` **lastSuccessAt**: `Date` \| `null`

##### name

> `readonly` **name**: `string`

##### nextRunAt

> `readonly` **nextRunAt**: `Date`

***

### ScheduleOptions

#### Properties

##### backoff?

> `readonly` `optional` **backoff?**: [`BackoffOptions`](#backoffoptions)

Defaults to `{ base: "5s", max: "1m" }`.

##### every

> `readonly` **every**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

##### maxAttempts?

> `readonly` `optional` **maxAttempts?**: `number`

Tries per tick. Defaults to 3.

##### timeout?

> `readonly` `optional` **timeout?**: `false` \| `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

Defaults to `"5m"`.

***

### StandardSchemaV1

The Standard Schema v1 interface (https://standardschema.dev), copied as the spec invites so
that groundwork has no runtime dependency for it. zod, valibot, arktype and others implement it.
Source: @standard-schema/spec 1.1.0 (MIT).

#### Type Parameters

##### Input

`Input` = `unknown`

##### Output

`Output` = `Input`

#### Properties

##### ~standard

> `readonly` **~standard**: [`Props`](namespaces/StandardSchemaV1.md#props)\<`Input`, `Output`\>

***

### WorkOptions

#### Properties

##### concurrency?

> `readonly` `optional` **concurrency?**: `number`

Jobs at once. Defaults to 4.

##### pollInterval?

> `readonly` `optional` **pollInterval?**: `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

How often to look for new jobs and due schedules when idle. Defaults to `"1s"`.

##### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Abort it to stop: no new jobs are claimed, and the call resolves once running jobs finish.

## Type Aliases

### BackoffOptions

> **BackoffOptions** = \{ `base?`: [`Duration`](../../groundwork.md#duration); `delays?`: `undefined`; `max?`: [`Duration`](../../groundwork.md#duration); \} \| \{ `base?`: `undefined`; `delays`: readonly [`Duration`](../../groundwork.md#duration)[]; `max?`: `undefined`; \}

How long a failed job waits before its next attempt. Either exponential with full jitter (a
random wait between 0 and `min(max, base * 2^(attempt - 1))`, the default), or a fixed ladder
of `delays`.

#### Union Members

##### Type Literal

\{ `base?`: [`Duration`](../../groundwork.md#duration); `delays?`: `undefined`; `max?`: [`Duration`](../../groundwork.md#duration); \}

###### base?

> `readonly` `optional` **base?**: [`Duration`](../../groundwork.md#duration)

Defaults to `"30s"`.

###### delays?

> `readonly` `optional` **delays?**: `undefined`

###### max?

> `readonly` `optional` **max?**: [`Duration`](../../groundwork.md#duration)

Defaults to `"1h"`.

***

##### Type Literal

\{ `base?`: `undefined`; `delays`: readonly [`Duration`](../../groundwork.md#duration)[]; `max?`: `undefined`; \}

###### base?

> `readonly` `optional` **base?**: `undefined`

###### delays

> `readonly` **delays**: readonly [`Duration`](../../groundwork.md#duration)[]

After the n-th failed attempt, wait `delays[n - 1]`, exactly; once the list runs out, its
last delay repeats. `["30s", "2m", "10m", "30m", "1h"]` retries after 30 seconds, then
2 minutes, and so on, then hourly. Up to 100 steps.

###### max?

> `readonly` `optional` **max?**: `undefined`

***

### JobStatus

> **JobStatus** = `"pending"` \| `"running"` \| `"completed"` \| `"failed"` \| `"cancelled"`

## Functions

### backoffDelayMs()

> **backoffDelayMs**(`attempt`, `baseMs`, `maxMs`, `random`): `number`

Exponential backoff with full jitter (AWS's "full jitter"): a random wait between 0 and
`min(maxMs, baseMs * 2^(attempt - 1))`. Spreading retries out keeps a burst of failures from
retrying in lockstep.

#### Parameters

##### attempt

`number`

##### baseMs

`number`

##### maxMs

`number`

##### random

() => `number`

#### Returns

`number`

***

### createJobs()

> **createJobs**(`options`): [`Jobs`](#jobs)

Creates background jobs and schedules on your Postgres.

```ts
const jobs = createJobs({ db, table: tables.jobs, schedulesTable: tables.jobSchedules });
export const sendReceipt = jobs.define("email.receipt", {
  schema: z.object({ orderId: z.string() }),
  async run({ orderId }, { signal }) { await mailer.send(orderId, { signal }); },
});
await sendReceipt.enqueue({ orderId }, { tx, dedupeKey: `receipt:${orderId}` });
await jobs.work({ signal });
```

#### Parameters

##### options

[`JobsOptions`](#jobsoptions)

#### Returns

[`Jobs`](#jobs)
