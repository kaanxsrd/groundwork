# groundwork docs

> Pre-release. Pages appear here as each module lands; [PLAN.md](../PLAN.md) has the schedule.

- [Core concepts](core-concepts.md): durations, the app secret, errors, logging and clocks. Shared by every module.
- [Table factories](schema.md): putting groundwork's tables in your Drizzle schema.
- [Rate limiting](rate-limiting.md): fixed windows, token buckets, headers, failure modes, Redis.
- [Audit log](audit.md): recording in transactions, diffs, redaction, querying, retention, tamper resistance.
- [API keys](api-keys.md): key format, scopes, verification, rotation, allowlists, per-key limits, migration from vante.app.

Coming with their phases: background jobs, idempotency keys, Next.js helpers, testing your app, and migrating from hand-rolled tables.
