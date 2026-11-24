---
"@vantedev/groundwork": patch
---

Durations that drive a timer are capped at 24 days, the longest a `setTimeout` can wait, and anything longer is rejected when configured. Before, a job `timeout: "30d"` made every attempt time out after 1 ms. An oversized `lease`, `pollInterval` or rate-limit `timeout` made its timer fire every millisecond. The cap covers job and schedule `timeout`, jobs and idempotency `lease`, `work({ pollInterval })` and the rate limiter's `timeout`.
