---
"@vantedev/groundwork": patch
---

Strings Postgres can't store no longer make a write throw. Postgres refuses `\u0000` in `text` and `jsonb`, and `jsonb` also refuses a lone surrogate: half of an emoji, which `text.slice(0, 100)` can leave, or which a client can send. An audit entry, a job's payload or result, or an API key's name, metadata or revoke reason with one used to throw, rolling back the caller's transaction with it. Now each is stored with U+FFFD (�) in its place, as text parameters already did for lone surrogates. Identifiers are refused with `invalid_argument` instead, in writes and in filters, because cleaning could make two of them the same, and a filter with the original value wouldn't find the row: a job's `dedupeKey`, an audit entry's actor and entity ids and types, request id and IP, an API key's `ownerId`, and an idempotency `scope`.
