# Contributing

Thanks for helping. Issues and pull requests are welcome; for anything large, open an issue first so we can agree on the shape. [PLAN.md](PLAN.md) is the source of truth for scope and design decisions.

## Setup

You need Bun 1.4, Docker and (for the smoke test) Node.js 22 or newer.

```sh
bun install
bun run db:up      # Postgres 18 on 127.0.0.1:54330, data in tmpfs
```

`POSTGRES_VERSION=16 bun run db:up` starts the oldest supported major instead (run `bun run db:down` first). Copy `.env.example` to `.env` to change the port or the defaults below.

## Before you push

```sh
bun run check      # Biome, TypeScript, unit tests
bun run test       # unit + integration tests (needs db:up)
bun run db:drift   # fails if the fixture schema changed without a migration
bun run smoke      # build, publint, attw, then the packed package on Node
```

CI runs all of these, and the integration tests against Postgres 16 and 18 with both drivers.

## Tests

- `tests/unit`: pure logic, no database. Fast; part of `bun run check`.
- `tests/integration`: real Postgres. Call `useTestDatabase()` at the top of the file:

  ```ts
  import { useTestDatabase } from "../support/database.ts";

  const database = useTestDatabase();

  test("…", async () => {
    const { db } = database.current;
    // …
  });
  ```

  Every test file gets its own database, cloned from a template that was migrated once from `tests/migrations`. The clone takes milliseconds, tests in different files can't see each other's rows, and `bun test --parallel` is safe. The clone is dropped when the file finishes; anything a crashed run leaves behind is dropped after an hour.

  `database.current.connect()` opens a second, independent pool to the same database, for simulating another app instance. `database.current.rows(sql\`…\`)` runs raw SQL and returns rows whichever driver is active.

- **Drivers.** `GW_TEST_DRIVER=node-postgres bun run test:integration` runs the integration tests over `pg` instead of `postgres` (postgres-js). Library code must work with both.
- **Race tests must race.** Use separate pools (`connect()`) and `Promise.all`, never a loop of awaits, and assert on the final database state, not only on return values.
- **Never only the happy path.** Every feature needs a test for how it fails.

## Database changes

The library never runs DDL: apps generate migrations from the table factories with their own drizzle-kit. The tests do the same:

1. Change the factories in `src/schema` (or the fixture in `tests/fixtures/schema.ts`).
2. `bun run db:generate` writes a migration to `tests/migrations`. Read it.
3. Commit the change and the migration together. `bun run db:drift` (also in CI) fails if you forget.

The harness notices new migrations by hashing them and builds a fresh template automatically.

## Conventions

- **TypeScript strict**, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. No `any`, no non-null assertions outside tests.
- **Relative imports end in `.ts`.** `tsc` rewrites them to `.js` in `dist/`. Biome enforces it.
- **No default exports**, and `import type` for types.
- **Biome** formats; don't hand-format. `bun run check:fix` applies fixes. Markdown is not formatted.
- **Public API is deliberate.** Anything exported from an entry point in `package.json` `exports` is public. Shared helpers live in `src/internal/` and are not reachable from outside the package.
- **No runtime dependencies.** `drizzle-orm` is the only peer dependency. Use `node:` built-ins.
- **Security.** Never log, return or put in an error message a secret, an API key, a raw rate-limit subject or a configured redacted field. Compare secrets with `timingSafeEqual` from `src/internal/crypto.ts`.
- **Errors.** Throw `GroundworkError` with a `code`; don't make callers parse messages.

## Changesets

Every user-visible change needs a changeset:

```sh
bun run changeset
```

Pick the bump (`minor` for features until 1.0) and describe the change for users. Changesets turns these into the version bump and `CHANGELOG.md` at release time.

## Build

`bun run build` compiles `src/` with `tsc` into unbundled ESM, `.d.ts` files and source maps in `dist/`, then checks that every `exports` target exists. There is no bundler on purpose: the output mirrors the source, so stack traces and tree-shaking stay simple.
