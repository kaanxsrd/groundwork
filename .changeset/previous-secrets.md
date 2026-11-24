---
"@vantedev/groundwork": minor
---

The app secret can be changed without invalidating API keys or idempotency keys: move the old one to `previousSecrets`, on `createGroundwork`, `createApiKeys` or `createIdempotency`.

```ts
createGroundwork({ db, tables, secret: newSecret, previousSecrets: [oldSecret] });
```

- API keys stored under a previous secret still verify, in the same single statement, and move to the new secret the first time they're used.
- Idempotency keys stored under a previous secret are still replayed (or answered 409 or 422) until they expire, so a retry across the change doesn't run twice. A request that crashed under the old secret is taken over as before.
- Rate limits start over.

It takes a list, newest first, or a function that returns one on first use, as `secret` does. The core-concepts docs explain how to rotate with several instances (two deploys) and how to tell when the old secret can go. The use that moves a key off a previous secret or a `legacyHash` is now always recorded in `lastUsedAt`, even within a minute of the last one.
