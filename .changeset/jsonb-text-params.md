---
"@vantedev/groundwork": patch
---

JSON values (job payloads and results, audit `changes` and `metadata`, API-key scopes, IP and origin lists, and `metadata`) are sent to Postgres as text and cast to `jsonb` there, so every driver stores them as JSON. postgres-js runs `JSON.stringify` on parameters the server types as `jsonb`. Drizzle 0.45 turns that off on the postgres-js clients it wraps, but Drizzle 1.0 doesn't, and the JSON groundwork had already encoded was encoded twice: job payloads, results and audit changes were stored as JSON strings, and creating an API key failed with "cannot extract elements from a scalar". Nothing changes on Drizzle 0.45 or with node-postgres.
