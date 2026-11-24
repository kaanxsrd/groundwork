---
"@vantedev/groundwork": patch
---

`apiKeys.create()` fixes when recording the key fails (the audit entry, or your `onEvent`):

- A unique violation from that hook no longer makes `create()` draw and insert another key. Only a collision on the new key's own prefix is retried.
- Without a `tx`, the key it just inserted is deleted before the error is rethrown, so no active key is left whose plaintext nobody received.

The docs no longer say changes are recorded in the same transaction without `tx`. groundwork only calls `db.execute()` and can't open one itself.
