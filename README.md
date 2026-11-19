<div align="center">

# groundwork

**Postgres-only, Drizzle-native building blocks for the plumbing every app rebuilds: rate limiting, audit logs, scoped API keys, background jobs and idempotency keys.**

<br>

[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL 16+](https://img.shields.io/badge/PostgreSQL-16%2B-4169e1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle-native-c5f74f?style=flat-square&logo=drizzle&logoColor=black)](https://orm.drizzle.team)
[![ESM only](https://img.shields.io/badge/ESM-only-f7df1e?style=flat-square&logo=javascript&logoColor=black)](https://nodejs.org/api/esm.html)
[![Bun](https://img.shields.io/badge/tested_on-Bun_%2B_Node_22-f9f1e1?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
[![Biome](https://img.shields.io/badge/lint-Biome-60a5fa?style=flat-square&logo=biome&logoColor=white)](https://biomejs.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)

**[Docs](docs/README.md)** ·
**[Contributing](CONTRIBUTING.md)** ·
**[Security](SECURITY.md)** ·
**[Plan](PLAN.md)**

</div>

> [!WARNING]
> **Pre-release.** groundwork is being built in the open and is not on npm yet. The API below is the target, not what ships today. See [PLAN.md](PLAN.md) for progress.

## Why

Most self-hosted Next.js + Drizzle + Postgres apps end up hand-writing the same five pieces. The existing libraries each cover one of them, and most bring their own schema, their own migrations or a Redis server.

groundwork takes a different shape:

- **Your schema.** The tables are factories you re-export from your own Drizzle schema, and your drizzle-kit generates the migrations. groundwork never runs DDL.
- **Your transaction.** Every write takes `{ tx }`, so an audit entry or an enqueued job commits or rolls back with the change that caused it.
- **Your names, typed.** Scopes, audit actions and job types are declared once and checked by TypeScript everywhere they're used.
- **No Redis needed.** Postgres is the only infrastructure. One round trip on hot paths.
- **Secure by default.** API keys and rate-limit subjects are stored as HMACs, comparisons are timing-safe, configured audit fields are redacted, and secrets are never logged.

## What's inside

| Module | Import | Status |
| --- | --- | --- |
| [Table factories](docs/schema.md) | `groundwork/schema` | Built, unreleased |
| [Rate limiting](docs/rate-limiting.md): fixed window and token bucket, optional Redis | `groundwork/rate-limit` | Built, unreleased |
| Audit log with diffs and redaction | `groundwork/audit` | Planned (Phase 2) |
| Scoped API keys with rotation and IP allowlists | `groundwork/api-keys` | Planned (Phase 3) |
| Background jobs and schedules | `groundwork/jobs` | Planned (Phase 4) |
| Idempotency keys | `groundwork/idempotency` | Planned (Phase 5) |
| Next.js route helpers | `groundwork/next` | Planned (Phase 5) |
| Test helpers for your app | `groundwork/testing` | Started (`createTestClock`) |

## Requirements

- PostgreSQL 16 or newer.
- `drizzle-orm` 0.45 with any Postgres driver (`postgres`, `pg`, Neon's websocket driver…). The jobs module needs interactive transactions, so it doesn't work over `neon-http`.
- Node.js 22+ or Bun 1.4+. ESM only.
- TypeScript 5.9+ if you use the types (CI checks 5.9, 6.0 and 7.0).
- Optional: Redis, only if you choose the Redis rate-limit store (tested with Redis 8, ioredis 6 and node-redis 6).

## Develop

```sh
bun install
bun run db:up            # Postgres (127.0.0.1:54330) and Redis (:63790) in Docker
bun run check            # Biome, TypeScript and unit tests
bun run test             # everything, including the integration tests
```

[CONTRIBUTING.md](CONTRIBUTING.md) explains the test harness, the migration workflow and the conventions.

## License

[MIT](LICENSE)
