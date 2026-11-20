import { index, text, timestamp } from "drizzle-orm/pg-core";
import type { TableFactory } from "./factory.ts";

/**
 * One row per idempotency key that has been seen and not yet expired.
 *
 * - `key`: base64url HMAC-SHA256 of the scope and the client's key. The raw key is never stored.
 * - `scope`: whose key it is (`apikey:…`, `user:…`), for operators.
 * - `fingerprint`: base64url HMAC-SHA256 of the request (method, path and body by default), so a
 *   key reused for a different request is rejected. The body itself is never stored.
 * - `locked_by` and `locked_until`: set while the first request runs. The lease is renewed while
 *   it runs, so a request that crashed frees its key once `locked_until` passes.
 * - `response`: the stored result, as JSON text, once the first request completed.
 * - `expires_at`: from this moment the row means the same as no row, so `cleanup()` may delete it.
 */
export function buildIdempotencyKeysTable<TSchema extends string | undefined>(
  factory: TableFactory<TSchema>,
) {
  const tableName = factory.name("idempotency_keys");
  const expiresAtIndex = factory.name("idempotency_keys_expires_at_idx");
  return factory.table(
    tableName,
    {
      key: text("key").primaryKey(),
      scope: text("scope").notNull(),
      fingerprint: text("fingerprint").notNull(),
      lockedBy: text("locked_by"),
      lockedUntil: timestamp("locked_until", { withTimezone: true }),
      response: text("response"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
      completedAt: timestamp("completed_at", { withTimezone: true }),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [index(expiresAtIndex).on(t.expiresAt)],
  );
}

/** The idempotency-key table, as returned by `groundworkTables()`. */
export type IdempotencyKeysTable<TSchema extends string | undefined = string | undefined> =
  ReturnType<typeof buildIdempotencyKeysTable<TSchema>>;

/** Column names the idempotency module's SQL relies on. */
export const IDEMPOTENCY_KEY_COLUMNS = [
  "key",
  "scope",
  "fingerprint",
  "locked_by",
  "locked_until",
  "response",
  "created_at",
  "completed_at",
  "expires_at",
] as const;
