---
"@vantedev/groundwork": patch
---

`enqueue` with a `dedupeKey` no longer throws "found neither a new job nor the duplicate it collided with" when the job it collided with commits just after the statement starts and finishes before it's looked up. It returns that job's id with `created: false`, as it would have a moment earlier, preferring a job that's still pending or running over an older finished one with the same key.
