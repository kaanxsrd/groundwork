# groundwork docs

- [Core concepts](core-concepts.md): durations, the app secret, errors, logging and clocks. Shared by every module.
- [Table factories](schema.md): putting groundwork's tables in your Drizzle schema.
- [Rate limiting](rate-limiting.md): fixed windows, token buckets, headers, failure modes, Redis.
- [Audit log](audit.md): recording in transactions, diffs, redaction, querying, retention, tamper resistance.
- [API keys](api-keys.md): key format, scopes, verification, rotation, allowlists, per-key limits, migration from vante.app.
- [Background jobs](jobs.md): defining and enqueueing jobs, workers, leases, retries, schedules, health.
- [Idempotency keys](idempotency.md): safe retries for HTTP handlers, webhooks and anything else, with stored responses.
- [Next.js route helpers](next.md): `withApiKey`, `withRateLimit`, `withIdempotency`, a cron route for jobs, and the client's IP.
- [Testing your app](testing.md): real Postgres, the test clock, running jobs and calling routes in tests.
- [Migrating from hand-rolled tables](migrating.md): what to do with old data, module by module and app by app.
- [Releasing](releasing.md): for maintainers, how a version gets to npm with provenance.

[`examples/next-app`](../examples/next-app) shows every module in one app.
