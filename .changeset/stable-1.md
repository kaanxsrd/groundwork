---
"@vantedev/groundwork": major
---

**groundwork 1.0: the API is stable.** From here on groundwork follows semver: a minor release adds, a patch fixes, and only a major breaks. [docs/releasing.md](https://github.com/kaanxsrd/groundwork/blob/main/docs/releasing.md#versions) says what counts as breaking. groundwork 1.x works with Drizzle 0.45; Drizzle 1.0 will come with groundwork 2.0, since the table types are tied to the Drizzle major. There's no migration in this release.

What to update from 0.4:

- **`runOnce({ budgetMs })` and `jobsRoute(gw, { budgetMs })` take `budget`, a duration:** `{ budget: "50s" }`. Passing `budgetMs` throws, with a message that names the new option.
- **`verify()`'s failure result always has `missingScopes`, `rateLimit` and `quota`:** an empty list and `null` when they don't apply, as the success result has `rateLimit` and `quota`. Before, they were missing. Code that checks `=== undefined` needs `=== null`, or `.length === 0` for `missingScopes`.
- **`ApiKeyEvent` is a union on `type`:** an `update` always has `before`, a `rotate` `grace`, and a `revoke` or `suspend` `reason` (`string | null`). Read them after narrowing on `type`.
- **`RateLimitStore` is opaque:** stores come from `redisStore()` and `memoryStore()`, and `Policy`, `ConsumeInput` and `StoreState` are no longer exported. A store of your own was the one interface marked as unstable; it isn't supported in 1.x.
- **`backoffDelayMs` is no longer exported.** A failed job's `runAt` says when it runs again.
- **`enqueue(…, { replace: true })` throws a `GroundworkError` with the new code `conflict`** after losing every retry to concurrent enqueues of the same key, instead of a plain `Error`.

Additions:

- `jobsRoute`'s `secret` can be a function, called on the first request, so `next build` works without `CRON_SECRET`. Its `budget` and `concurrency` are checked when it's created, so a typo fails at startup instead of on every cron call.
- `Groundwork`'s type parameters default to `string`, so a configured instance can be passed where a plain `Groundwork` is expected.
