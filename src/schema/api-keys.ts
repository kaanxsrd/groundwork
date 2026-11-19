import { sql } from "drizzle-orm";
import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TableFactory } from "./factory.ts";

/**
 * One row per API key. The key itself is never stored: only `key_hash`, an HMAC-SHA256 of the
 * key under a subkey of the app secret. `prefix` (12 hex characters) is stored in the clear so
 * people can tell keys apart: `vnt_3f9ca0c44a15…`.
 *
 * - `previous_key_hash` / `previous_key_expires_at`: after `rotate()`, the old key keeps working
 *   until the grace period ends.
 * - `rate_limit` / `rate_limit_window` and `daily_quota`: enforced through the rate limiter.
 * - `allowed_ips` (canonical CIDR) and `allowed_origins` (canonical origins): empty means any.
 */
export function buildApiKeysTable<TSchema extends string | undefined>(
  factory: TableFactory<TSchema>,
) {
  // Every name is built up front: Drizzle calls the extraConfig callback lazily.
  const tableName = factory.name("api_keys");
  const byHash = factory.name("api_keys_key_hash_idx");
  const byPrefix = factory.name("api_keys_prefix_idx");
  const byPreviousHash = factory.name("api_keys_previous_key_hash_idx");
  const byOwner = factory.name("api_keys_owner_idx");
  return factory.table(
    tableName,
    {
      id: uuid("id").primaryKey().defaultRandom(),
      name: text("name").notNull(),
      description: text("description"),
      prefix: text("prefix").notNull(),
      keyHash: text("key_hash").notNull(),
      previousKeyHash: text("previous_key_hash"),
      previousKeyExpiresAt: timestamp("previous_key_expires_at", { withTimezone: true }),
      scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
      ownerId: text("owner_id"),
      rateLimit: integer("rate_limit"),
      rateLimitWindow: text("rate_limit_window"),
      dailyQuota: integer("daily_quota"),
      allowedIps: text("allowed_ips").array().notNull().default(sql`'{}'::text[]`),
      allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
      metadata: jsonb("metadata").$type<Record<string, unknown>>(),
      expiresAt: timestamp("expires_at", { withTimezone: true }),
      revokedAt: timestamp("revoked_at", { withTimezone: true }),
      revokedReason: text("revoked_reason"),
      suspendedUntil: timestamp("suspended_until", { withTimezone: true }),
      suspendedReason: text("suspended_reason"),
      rotatedAt: timestamp("rotated_at", { withTimezone: true }),
      lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
      lastUsedIp: text("last_used_ip"),
      createdBy: text("created_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      uniqueIndex(byHash).on(t.keyHash),
      uniqueIndex(byPrefix).on(t.prefix),
      index(byPreviousHash).on(t.previousKeyHash).where(sql`previous_key_hash is not null`),
      index(byOwner).on(t.ownerId, t.createdAt),
    ],
  );
}

/** The API-key table, as returned by `groundworkTables()`. */
export type ApiKeysTable<TSchema extends string | undefined = string | undefined> = ReturnType<
  typeof buildApiKeysTable<TSchema>
>;

/** Column names the API-key module's SQL relies on. */
export const API_KEY_COLUMNS = [
  "id",
  "name",
  "description",
  "prefix",
  "key_hash",
  "previous_key_hash",
  "previous_key_expires_at",
  "scopes",
  "owner_id",
  "rate_limit",
  "rate_limit_window",
  "daily_quota",
  "allowed_ips",
  "allowed_origins",
  "metadata",
  "expires_at",
  "revoked_at",
  "revoked_reason",
  "suspended_until",
  "suspended_reason",
  "rotated_at",
  "last_used_at",
  "last_used_ip",
  "created_by",
  "created_at",
  "updated_at",
] as const;
