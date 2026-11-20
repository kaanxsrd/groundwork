# Core concepts

Things every groundwork module shares. Types are exported from the root entry point:

```ts
import { type Duration, GroundworkError, isGroundworkError, type Logger, type Clock, type Secret } from "@vantedev/groundwork";
```

## Durations

Anywhere groundwork asks for a length of time (a rate-limit window, a key's expiry, a job timeout), it takes a `Duration`: a number followed by a unit.

| Unit | Meaning | Example |
| --- | --- | --- |
| `ms` | milliseconds | `"500ms"` |
| `s` | seconds | `"30s"` |
| `m` | minutes | `"15m"` |
| `h` | hours | `"24h"` |
| `d` | days | `"90d"` |
| `w` | weeks | `"2w"` |

Decimals work (`"1.5h"`). TypeScript rejects a missing unit, and groundwork throws a `GroundworkError` with code `invalid_argument` for anything malformed at runtime.

Two things are deliberately missing:

- **Bare numbers.** `window: 60` could mean seconds or milliseconds, so it isn't accepted. Build a duration from a variable with a template literal: `` `${days}d` ``.
- **Months and years.** They have no fixed length. Use `"30d"` or `"365d"`.

## The app secret

Modules that hash things (rate-limit subjects, API keys, idempotency fingerprints) need one app secret of at least 32 bytes:

```sh
openssl rand -base64 32
```

groundwork never uses it directly. It derives a separate 256-bit key for each purpose with HKDF-SHA256, so a key derived for rate limiting can never be used to forge an API key hash. The secret can be a string (its UTF-8 bytes count) or a `Uint8Array`.

Because only derived keys are used, reusing a secret your app already has, such as `BETTER_AUTH_SECRET`, is safe: nothing groundwork stores or sends can reveal it or be used against the other system.

The secret can also be a function, called once, on first use (the first rate-limit check, key hash or idempotency claim):

```ts
const gw = createGroundwork({ db, tables, secret: () => env().GROUNDWORK_SECRET });
```

That lets you create `gw` at module scope when the environment isn't set during `next build`, and run a worker that only cleans up or runs jobs without the secret at all. A plain secret that's too short fails at startup; a function that returns one fails on first use.

> [!IMPORTANT]
> Stored API key hashes are derived from this secret. **Changing the secret invalidates every API key** and resets every rate limit. Keep it stable, keep it out of source control, and back it up with your database credentials. Support for rotating to a new secret (`previousSecrets`) is planned.

## Errors

groundwork throws one error class on purpose: `GroundworkError`. Branch on its `code`, not on the message:

```ts
try {
  // …
} catch (error) {
  if (isGroundworkError(error) && error.code === "invalid_config") {
    // a startup misconfiguration
  }
  throw error;
}
```

| Code | Meaning |
| --- | --- |
| `invalid_config` | Options passed when creating a module are wrong. Thrown at startup, never per request. |
| `invalid_argument` | A value passed to a method is wrong, such as a malformed duration. |

Modules add codes as they land. `isGroundworkError()` works even if two copies of groundwork end up in your dependency tree, where `instanceof` would not. Error messages never contain secrets, API keys or rate-limit subjects.

Expected outcomes are not errors: a denied rate-limit check or a rejected API key comes back as a result value, not a throw.

## Logging

groundwork logs rarely: a degraded mode (such as falling back to the in-memory rate limiter while Postgres is down) is logged once, not on every request. Pass any object with `warn` and `error` methods; `debug` and `info` are optional.

```ts
import type { Logger } from "@vantedev/groundwork";

const logger: Logger = console; // works as is
```

pino takes the context first. Wrap it in `pinoLogger`, which swaps the arguments (it works for any logger whose methods take `(context, message)`):

```ts
import { createGroundwork, pinoLogger } from "@vantedev/groundwork";
import { logger } from "./logger"; // your pino instance

const gw = createGroundwork({ db, tables, secret, logger: pinoLogger(logger) });
```

By default warnings and errors go to the console with a `[groundwork]` prefix. Log context never contains secrets, raw keys or raw subjects.

## Clocks

Modules that depend on time take a `Clock`, an object with `now(): Date`. Without one, each module uses the most trustworthy clock it has: rate limiting asks Postgres (or Redis), so app instances with skewed clocks still agree. In tests, inject a clock you control:

```ts
import { createTestClock } from "@vantedev/groundwork/testing";

const clock = createTestClock("2026-01-01T00:00:00Z");
clock.advance("15m");      // or advance(250) for milliseconds
clock.set("2026-06-01T00:00:00Z");
```

Any object with `now(): Date` works too.
