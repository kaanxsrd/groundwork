import { doublePrecision, index, text, timestamp } from "drizzle-orm/pg-core";
import type { TableFactory } from "./factory.ts";

/**
 * One row per rule and subject that has been seen recently.
 *
 * - `key`: base64url HMAC-SHA256 of the algorithm, the rule name and the subject. The raw subject
 *   (an IP address, a user id…) is never stored.
 * - `rule`: the rule name, for operators. Never the subject.
 * - `used`: fixed window: the cost spent in the current window. Token bucket: tokens taken and not
 *   yet refilled (the bucket holds `burst - used` tokens as of `updated_at`).
 * - `expires_at`: from this moment the row means the same as no row, so `cleanup()` may delete it.
 */
export function buildRateLimitsTable<TSchema extends string | undefined>(
  factory: TableFactory<TSchema>,
) {
  // Every name is built here, not inside the extraConfig callback: Drizzle calls that lazily, so
  // a bad prefix would otherwise only fail later, inside drizzle-kit.
  const tableName = factory.name("rate_limits");
  const expiresAtIndex = factory.name("rate_limits_expires_at_idx");
  return factory.table(
    tableName,
    {
      key: text("key").primaryKey(),
      rule: text("rule").notNull(),
      used: doublePrecision("used").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [index(expiresAtIndex).on(t.expiresAt)],
  );
}

/** The rate-limit table, as returned by `groundworkTables()`. */
export type RateLimitsTable<TSchema extends string | undefined = string | undefined> = ReturnType<
  typeof buildRateLimitsTable<TSchema>
>;

/** Column names the rate limiter's SQL relies on. */
export const RATE_LIMIT_COLUMNS = ["key", "rule", "used", "updated_at", "expires_at"] as const;
