---
"groundwork": minor
---

Idempotency keys and Next.js route helpers.

- `groundworkTables()` now also returns `idempotencyKeys` (`gw_idempotency_keys`). Keys and request fingerprints are stored as HMACs; responses are stored as JSON text.
- `groundwork/idempotency`: `createIdempotency({ db, table, secret, ttl, lease })`, or `gw.idempotency` from `createGroundwork`.
  - `handle(request, { scope, required, ttl, fingerprint }, handler)` follows draft-ietf-httpapi-idempotency-key-header-08. A completed 2xx or 3xx response is replayed with `Idempotent-Replayed: true`; reuse with a different body, path or method is a 422; a duplicate while the first request runs is a 409; a missing (when `required`) or malformed key is a 400. Errors aren't stored, so clients can retry.
  - Concurrent duplicates run the handler once. A running request holds its key with a lease that is renewed while it runs, so a crashed request frees its key within `lease` (default `"30s"`).
  - `Set-Cookie` and per-request headers are never stored.
  - `run({ scope, key, fingerprint }, fn)` does the same for anything that isn't an HTTP handler, and returns the stored JSON value, typed with `Jsonify<T>`.
  - `cleanup()` deletes expired keys. `createGroundwork` schedules it hourly once you use `gw.jobs` (`jobs: { idempotencyCleanup: false }` turns it off).
- `groundwork/next`, with no dependency on `next`:
  - `createRouteHelpers(gw, { trustProxy })` returns `withApiKey(scopes, handler)`, `withRateLimit(rule, key, handler)`, `withIdempotency(options, handler)` and `clientIp(request)`. Wrappers nest, and what an outer one adds (`context.apiKey`) is typed in the ones inside.
  - `jobsRoute(gw, { secret, budgetMs, concurrency })`: a bearer-protected HTTP trigger for `gw.jobs.runOnce()`, for Vercel Cron and other schedulers. `?schedule=<name>` runs a schedule now.
  - `getClientIp(request, { trustProxy })` reads only the header you trust: `"vercel"`, `"cloudflare"`, or `{ header, hops }` for `X-Forwarded-For` behind your own proxies. The default, `"none"`, reads nothing.
- `examples/next-app` uses every module in a Next.js 16 app.
