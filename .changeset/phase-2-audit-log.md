---
"groundwork": minor
---

Audit log.

- `groundworkTables()` now also returns `auditLog` (`gw_audit_log`). It is append-only: identity ids, `occurred_at` defaults to the transaction's `now()`, and every filter column is indexed together with `(occurred_at, id)`.
- `groundwork/audit`: `createAuditLog({ db, table, actions, entityTypes?, redact?, redactDefaults? })`.
  - Actions and entity types are inferred from the config.
  - `record(event, { tx })` writes inside your transaction; `recordMany` writes up to 1,000 entries in one statement, all or none.
  - Events are validated before anything is sent, and recording throws rather than swallowing errors.
  - `changes` and `metadata` are redacted at any depth, using `DEFAULT_REDACT` plus your rules, and normalised to JSON.
  - `query()` uses keyset pagination on `(occurred_at, id)` and filters by action, actor, entity, request id, time range, literal text search, or any Drizzle `where`. It reads newest first, or oldest first with `order: "asc"`.
  - `count()` takes the same filters; `prune({ olderThan })` deletes in batches.
- `diff(before, after, { ignore })` returns only the changed fields, as `[before, after]`.
- `createGroundwork({ audit: { actions } })` exposes the log as `gw.audit`.
