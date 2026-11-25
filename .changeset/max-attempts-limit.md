---
"@vantedev/groundwork": patch
---

A `maxAttempts` above 2,147,483,647, the most the `max_attempts` column holds, is refused when a job type or schedule is defined (`invalid_config`) or a job is enqueued (`invalid_argument`). Before, the type could be defined, and enqueueing failed in Postgres with "integer out of range".
