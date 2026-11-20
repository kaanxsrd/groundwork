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

## Quickstart

In a Next.js app (`npx create-next-app@latest`) with a Postgres database:

```sh
npm install groundwork drizzle-orm postgres
npm install -D drizzle-kit
```

**1. Add groundwork's tables to your Drizzle schema**, and let drizzle-kit create them. Put `DATABASE_URL` in `.env.local`, plus `GROUNDWORK_SECRET` and `CRON_SECRET`, each from `openssl rand -base64 32`.

```ts filename="db/schema.ts"
import { groundworkTables } from "groundwork/schema";

export const { rateLimits, auditLog, apiKeys, jobs, jobSchedules, idempotencyKeys } =
  groundworkTables();
```

```ts filename="drizzle.config.ts"
import { defineConfig } from "drizzle-kit";

process.loadEnvFile(".env.local");

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

```sh
npx drizzle-kit generate
npx drizzle-kit migrate
```

**2. Create one instance** with your own names. Audit actions, API-key scopes and job payloads are typed from here on.

```ts filename="lib/groundwork.ts"
import { drizzle } from "drizzle-orm/postgres-js";
import { createGroundwork } from "groundwork";
import { createRouteHelpers } from "groundwork/next";
import postgres from "postgres";
import * as tables from "@/db/schema";

export const db = drizzle(postgres(process.env.DATABASE_URL ?? ""));

export const gw = createGroundwork({
  db,
  tables,
  secret: process.env.GROUNDWORK_SECRET ?? "",
  audit: { actions: ["note.create"] },
  apiKeys: { namespace: "demo", scopes: { "notes:write": "Create notes" } },
});

export const { withApiKey, withIdempotency } = createRouteHelpers(gw);

export const noteCreated = gw.jobs.define("note.created", {
  async run(note: { id: string }) {
    console.log(`Note ${note.id} was created.`);
  },
});
```

**3. Protect a route** with a scoped API key and make it safe to retry. The audit entry and the job commit together with your write, or not at all:

```ts filename="app/api/notes/route.ts"
import { db, gw, noteCreated, withApiKey, withIdempotency } from "@/lib/groundwork";

export const POST = withApiKey(
  ["notes:write"],
  withIdempotency(
    { scope: (_request, { apiKey }) => `apikey:${apiKey.id}` },
    async (request, { apiKey }) => {
      const { text } = await request.json();
      const id = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await gw.audit.record(
          { actor: { type: "api_key", id: apiKey.id }, action: "note.create", metadata: { id, text } },
          { tx },
        );
        await noteCreated.enqueue({ id }, { tx });
      });
      return Response.json({ id }, { status: 201 });
    },
  ),
);
```

**4. Run jobs** from a cron route (Vercel Cron sends `CRON_SECRET` for you), or with `gw.jobs.work()` in a long-running process:

```ts filename="app/api/jobs/route.ts"
import { jobsRoute } from "groundwork/next";
import { gw } from "@/lib/groundwork";

export const GET = jobsRoute(gw, { secret: process.env.CRON_SECRET ?? "" });
export const POST = GET;
```

**5. Create a key** once, from a script or your admin UI, and call the route. A retry with the same `Idempotency-Key` gets the first response back:

```ts
const { key } = await gw.apiKeys.create({ name: "My CLI", scopes: ["notes:write"] });
```

```sh
curl -X POST http://localhost:3000/api/notes -H "Authorization: Bearer $KEY"   -H "Idempotency-Key: $(uuidgen)" -d '{"text":"Hello"}'
```

[`examples/next-app`](examples/next-app) uses every module, with rate limits, a schedule and an audit-log endpoint. CI builds both it and this quickstart in a fresh `create-next-app` project, then runs requests against them.

## What's inside

| Module | Import | Status |
| --- | --- | --- |
| [Table factories](docs/schema.md) | `groundwork/schema` | Built, unreleased |
| [Rate limiting](docs/rate-limiting.md): fixed window and token bucket, optional Redis | `groundwork/rate-limit` | Built, unreleased |
| [Audit log](docs/audit.md) with diffs, redaction and keyset pagination | `groundwork/audit` | Built, unreleased |
| [Scoped API keys](docs/api-keys.md) with rotation, CIDR allowlists and per-key limits | `groundwork/api-keys` | Built, unreleased |
| [Background jobs](docs/jobs.md) and schedules, with leases and jittered retries | `groundwork/jobs` | Built, unreleased |
| [Idempotency keys](docs/idempotency.md) with stored responses, per the IETF draft | `groundwork/idempotency` | Built, unreleased |
| [Next.js route helpers](docs/next.md): API keys, rate limits, idempotency, a jobs cron route | `groundwork/next` | Built, unreleased |
| Test helpers for your app | `groundwork/testing` | Started (`createTestClock`) |

## Requirements

- PostgreSQL 16 or newer.
- `drizzle-orm` 0.45 with any Postgres driver (`postgres`, `pg`, Neon's websocket driver…). groundwork's own statements are all single statements; passing `{ tx }` needs a driver that supports transactions. CI tests `postgres` and `pg`.
- Node.js 22+ or Bun 1.4+. ESM only.
- For `groundwork/next`: nothing extra. It never imports `next`; CI tests it with Next.js 16.
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
