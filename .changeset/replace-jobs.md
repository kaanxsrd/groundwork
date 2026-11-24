---
"@vantedev/groundwork": minor
---

`enqueue(payload, { dedupeKey, replace: true })` debounces a job: the pending job with that key takes this call's payload, timing, priority and `maxAttempts`, and keeps its id (`created: false`).

```ts
await sendDigest.enqueue({ userId }, { dedupeKey: `digest:${userId}`, delay: "5m", replace: true });
```

If the job with the key is already running, it keeps running without the key, and a new job is enqueued with the latest payload, so no change is lost. Its current attempt becomes its last, so its out-of-date payload is never retried after the new one. A running job whose worker has stopped is replaced like a pending one, and that worker can no longer complete it. A replaced job gets the call's `maxAttempts` on top of the attempts it has used. Without `replace`, `dedupeKey` keeps the existing job as before.
