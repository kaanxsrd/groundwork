---
"@vantedev/groundwork": patch
---

`apiKeys.rotate()` retries when the new key's prefix collides with an existing one, as `create()` does, instead of failing with a raw database error. A per-key `rateLimit.limit` above 2,147,483,647 is rejected as an invalid argument instead of failing in Postgres.
