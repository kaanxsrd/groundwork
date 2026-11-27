---
"@vantedev/groundwork": patch
---

Jobs: four fixes to how a worker runs them.

- **A job whose handler succeeded is never retried because of its result.** Before, if the result couldn't be stored, the job counted as a failed attempt: it ran again, repeating its side effects, until it ran out of attempts and `onExhausted` reported work that was done. Such a result is now stored as `null`, with an error logged. A database error while recording the outcome leaves the job to its lease, as a crash would.
- **A schema whose `validate` throws** (a transform calling `new Date(x).toISOString()` on an older payload, say) **fails the job at once**, with the real error as `lastError`. Before, the job sat in `running` until its lease ran out, its error was never logged, and `runOnce()` threw, so no other job in that call ran.
- **One job's error no longer stops `runOnce()`** or the other jobs of a `work()` loop. It's logged, and the job runs again after its lease.
- **`work()` no longer leaks memory while a job runs for a long time.** Every idle poll added a reaction to each running job's promise: at the default 1s poll, about 86,000 a day for one long job.
