# @vantedev/groundwork/testing

`@vantedev/groundwork/testing`: helpers for testing apps that use groundwork.

## Interfaces

### TestClock

A clock that only moves when you move it.

#### Extends

- [`Clock`](../groundwork.md#clock)

#### Methods

##### advance()

> **advance**(`by`): `Date`

Moves forward by a duration, or by a number of milliseconds. Returns the new time.

###### Parameters

###### by

`number` \| `` `${number}ms` `` \| `` `${number}s` `` \| `` `${number}m` `` \| `` `${number}h` `` \| `` `${number}d` `` \| `` `${number}w` ``

###### Returns

`Date`

##### now()

> **now**(): `Date`

###### Returns

`Date`

###### Inherited from

[`Clock`](../groundwork.md#clock).[`now`](../groundwork.md#now)

##### set()

> **set**(`to`): `Date`

Jumps to a time (a `Date`, epoch milliseconds or an ISO string). Returns it.

###### Parameters

###### to

`string` \| `number` \| `Date`

###### Returns

`Date`

## Functions

### createTestClock()

> **createTestClock**(`start?`): [`TestClock`](#testclock)

Creates a clock for tests. Pass it as `clock` to groundwork modules, then move time yourself:

```ts
const clock = createTestClock("2026-01-01T00:00:00Z");
const limiter = createRateLimiter({ db, table, secret, clock });
clock.advance("15m");
```

#### Parameters

##### start?

`string` \| `number` \| `Date` = `"2026-01-01T00:00:00.000Z"`

#### Returns

[`TestClock`](#testclock)
