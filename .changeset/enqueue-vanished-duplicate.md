---
"@vantedev/groundwork": patch
---

`enqueue` with a `dedupeKey` no longer throws "found neither a new job nor the duplicate it collided with" when the job it collided with commits just after the statement starts, and changes before it's looked up again:

- If that job finished, `enqueue` returns its id with `created: false`, as it would have a moment earlier. A job with the key that's still pending or running wins over a finished one, even one created later.
- If a `replace` took its key, the key is free, so the job is enqueued (`created: true`).
