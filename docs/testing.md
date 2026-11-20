# Testing your app

How to test code that uses groundwork: what to run against a real database, how to control time, and how to call your route handlers directly.

## Use a real Postgres

groundwork's behaviour lives in its SQL: the claims, the leases, the conditional upserts. A fake database can't tell you whether your code and that SQL work together, so test against Postgres. groundwork's own suite does it this way:

- one database per test file, created from a template that already has your migrations, so files run in parallel without seeing each other's rows;
- your real migrations, applied with `drizzle-orm`'s `migrate()`, so the tests also check that the migrations match the schema.

The Docker Compose file and the harness in this repository ([`tests/support/database.ts`](../tests/support/database.ts)) are a working starting point.

For unit tests that touch only rate limiting, the in-memory store needs no database:

```ts
import { memoryStore } from "@vante/groundwork/rate-limit";

const gw = createGroundwork({ db, tables, secret, rateLimit: { store: memoryStore() } });
```

## Control time with `createTestClock`

Windows, TTLs, expiry, retries and schedules all depend on time. Pass a test clock and move it yourself instead of sleeping:

```ts
import { createTestClock } from "@vante/groundwork/testing";

const clock = createTestClock("2026-01-01T00:00:00Z");
const gw = createGroundwork({ db, tables, secret, clock });

const login = gw.rateLimit.rule({ name: "login", limit: 5, window: "15m" });
for (let i = 0; i < 5; i++) await login.check("203.0.113.7");
expect((await login.check("203.0.113.7")).allowed).toBe(false);

clock.advance("15m");
expect((await login.check("203.0.113.7")).allowed).toBe(true);
```

- `advance(duration)` only moves forward; `set(time)` jumps anywhere.
- Without a clock, groundwork uses Postgres's `now()`. With one, every statement uses the clock's time instead, so all your instances must share it: a job enqueued on the real clock is in the future for a worker on a clock set to 2026-01-01.
- A job's lease ends when the clock passes it. Advancing by more than a running job's lease hands that job to the next worker, exactly as a crashed worker would.

## Run jobs on demand

There's no need for a background worker in tests. Enqueue, then run what's due:

```ts
await sendReceipt.enqueue({ orderId });
const summary = await gw.jobs.runOnce();
expect(summary).toMatchObject({ completed: 1, failed: 0 });
```

`runOnce()` returns once nothing more is due. To test a retry, advance the clock past the backoff and call it again. To run a schedule now, call `gw.jobs.trigger(name)` first.

## Call route handlers directly

Route handlers are plain functions of a `Request`, so call them without a server:

```ts
import { POST } from "@/app/api/posts/route";

const { key } = await gw.apiKeys.create({ name: "test", scopes: ["posts:write"] });
const response = await POST(
  new Request("http://test/api/posts", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "idempotency-key": "test-key-0001" },
    body: JSON.stringify({ title: "Hello" }),
  }),
  { params: Promise.resolve({}) },
);
expect(response.status).toBe(201);
```

Send the same request again to check that it replays, with `Idempotent-Replayed: true`.

## Assert that nothing went wrong quietly

groundwork logs what it recovers from: a rate-limit store falling back to memory, a lease it couldn't renew. Pass a logger that records, and check that it stayed empty:

```ts
const lines: string[] = [];
const logger = { warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
const gw = createGroundwork({ db, tables, secret, logger });
// …
expect(lines).toEqual([]);
```
