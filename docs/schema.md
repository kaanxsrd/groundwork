# Table factories

groundwork's tables live in your Drizzle schema. You export them, and your drizzle-kit generates the migrations. groundwork never runs DDL itself.

```ts
// src/db/schema/groundwork.ts
import { groundworkTables } from "groundwork/schema";

export const { rateLimits, auditLog, apiKeys } = groundworkTables();
```

Make sure drizzle-kit reads this file (it's covered by the `schema` glob in `drizzle.config.ts`), then:

```sh
npx drizzle-kit generate   # writes the migration; read it
npx drizzle-kit migrate    # or apply it however you apply migrations today
```

**Only the tables you export are created.** Destructure just the ones for the modules you use. As more modules land, `groundworkTables()` returns more tables, but nothing changes in your database until you export them.

## Options

```ts
groundworkTables({ prefix: "gw_", schema: undefined });
```

| Option | Default | Effect |
| --- | --- | --- |
| `prefix` | `"gw_"` | Prepended to every table and index name: `gw_rate_limits`, `gw_rate_limits_expires_at_idx`. The default keeps groundwork's tables apart from yours, so a hand-rolled `rate_limits` table can live next to `gw_rate_limits` while you migrate. `""` gives plain names. Lower-case letters, digits and underscores only. |
| `schema` | none | A Postgres schema to put the tables in. Without it they go wherever your connection's `search_path` points, usually `public`. |

When you set `schema`, **also export the returned `schema` object**. Without it drizzle-kit generates `CREATE TABLE "ops"."gw_rate_limits"` but no `CREATE SCHEMA`, and the migration fails on a fresh database:

```ts
export const { schema: groundworkSchema, rateLimits } = groundworkTables({ schema: "ops" });
```

If your app already exports a `pgSchema("ops")` of its own, you don't need to export groundwork's too.

Invalid options throw a `GroundworkError` with code `invalid_config` when `groundworkTables()` runs. That includes a prefix long enough to push a name past Postgres's 63-character limit, so the problem surfaces at startup, not halfway through a migration.

## The tables

### `gw_rate_limits`

One row per rule and subject seen recently. See [rate limiting](rate-limiting.md).

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | `text` primary key | base64url HMAC-SHA256 of the algorithm, rule name and subject. The raw subject, such as an IP address, is never stored. |
| `rule` | `text` | The rule's name, for operators. |
| `used` | `double precision` | Fixed window: cost spent in the current window. Token bucket: tokens taken and not yet refilled as of `updated_at`. |
| `updated_at` | `timestamptz` | When the row last changed. |
| `expires_at` | `timestamptz` | From this moment the row means the same as no row. Indexed; `cleanup()` deletes by it. |

### `gw_audit_log`

Append-only: groundwork inserts, and deletes only in `prune()`. See [audit log](audit.md).

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `bigint` identity primary key | Assigned by Postgres (`GENERATED ALWAYS`), so it can't be supplied. |
| `occurred_at` | `timestamptz`, default `now()` | When it happened: the transaction's time unless set. With `id`, it orders the log. |
| `actor_type`, `actor_id`, `actor_label` | `text` | Who did it. |
| `action` | `text` | What they did, from your declared actions. |
| `entity_type`, `entity_id` | `text` | What it was done to. |
| `summary` | `text` | A sentence for people. |
| `changes`, `metadata` | `jsonb` | Redacted before insert. |
| `ip`, `request_id` | `text` | As given. |

Indexes: `(occurred_at, id)`, plus `action`, `(entity_type, entity_id)` and `(actor_type, actor_id)`, each followed by `(occurred_at, id)`, so every filter can page without sorting.

### `gw_api_keys`

One row per key. The key itself is never stored. See [API keys](api-keys.md).

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | `uuid` primary key | `gen_random_uuid()`. |
| `name`, `description` | `text` | For people. |
| `prefix` | `text`, unique | 12 hex characters, shown as `vnt_<prefix>`. |
| `key_hash` | `text`, unique | HMAC-SHA256 of the key under the API-key subkey. |
| `previous_key_hash`, `previous_key_expires_at` | `text`, `timestamptz` | The key before the last rotation, valid until its grace period ends. Partial index. |
| `scopes` | `text[]` | Granted scopes, including `resource:*` wildcards. |
| `owner_id` | `text` | Whose key it is. Indexed with `created_at`. |
| `rate_limit`, `rate_limit_window` | `integer`, `text` | Per-key limit, such as `60` per `1m`. Null for none. |
| `daily_quota` | `integer` | Requests per day. Null for none. |
| `allowed_ips`, `allowed_origins` | `text[]` | Canonical CIDR blocks and origins. Empty means any. |
| `metadata` | `jsonb` | Your own data. |
| `expires_at`, `revoked_at`, `revoked_reason`, `suspended_until`, `suspended_reason`, `rotated_at` | | Lifecycle. |
| `last_used_at`, `last_used_ip` | | Updated at most once a minute. |
| `created_by`, `created_at`, `updated_at` | | Bookkeeping. |

## Using the tables directly

They're ordinary Drizzle tables, so you can query them for dashboards or debugging:

```ts
import { count, desc } from "drizzle-orm";

const hottest = await db
  .select({ rule: rateLimits.rule, subjects: count() })
  .from(rateLimits)
  .groupBy(rateLimits.rule)
  .orderBy(desc(count()));
```

Don't write to them yourself. The modules rely on invariants (such as `expires_at`) that a stray update can break.
