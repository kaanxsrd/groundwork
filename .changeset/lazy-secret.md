---
"@vantedev/groundwork": minor
---

`secret` can be a function, called once on first use: the first rate-limit check, key hash or idempotency claim. You can create `gw` at module scope when the environment isn't set during `next build`, and a worker that only cleans up or runs jobs needs no secret. A plain secret is still checked at startup, and both forms derive the same keys. The docs now say that reusing an existing app secret, such as `BETTER_AUTH_SECRET`, is safe.
