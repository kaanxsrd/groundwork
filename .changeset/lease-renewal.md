---
"@vantedev/groundwork": patch
---

Job and idempotency leases are renewed every third of the lease, also for short leases. The interval used to be at least 1 second, so a `lease: "1s"` was renewed exactly as it ran out, and another worker could claim a job (or another request take over a key) while it was still running. A 2-second lease was renewed at half its length instead of a third.
