---
"@vantedev/groundwork": minor
---

`apiKeys.verify()` returns the checks behind its headers. On success, `rateLimit` and `quota` (`limit`, `remaining`, `resetAt`), or `null` when the key has none. On a `rate_limited` or `quota_exceeded` failure, the check that denied it. Apps that send their own rate-limit headers no longer parse groundwork's.
