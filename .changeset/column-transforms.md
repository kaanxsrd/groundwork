---
"@vantedev/groundwork": patch
---

groundwork works on a postgres-js client with a built-in column transform (`postgres.camel`, `postgres.pascal` or `postgres.kebab`). Before, such a client renamed the columns groundwork reads: a rate-limit check failed with "Expected a number from the database" and fell back to its in-memory store, and API keys, the audit log, jobs and idempotency failed too. Your JSON was never at risk, because groundwork already read job payloads, audit metadata and stored responses as text, which the transforms don't rename. A custom `transform` that renames columns some other way still isn't supported.
