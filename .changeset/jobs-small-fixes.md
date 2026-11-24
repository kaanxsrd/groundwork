---
"@vantedev/groundwork": patch
---

- A schedule run whose stored payload has no `scheduledAt` (a hand-written row, say) gets the job's creation time, not an Invalid Date.
- If adding groundwork's cleanup schedules throws when `gw.jobs` is first used (a bad `idempotency.ttl`, say), later accesses throw too. Before, they returned an instance without the cleanup schedules.
