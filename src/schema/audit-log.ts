import { bigint, index, jsonb, text, timestamp } from "drizzle-orm/pg-core";
import type { TableFactory } from "./factory.ts";

/**
 * Append-only: groundwork inserts rows and, in `prune()`, deletes old ones. It never updates.
 *
 * - `id`: an identity column, so ids are assigned by Postgres and can't be supplied.
 * - `occurred_at`: the transaction's time (`now()`), so an entry recorded with a business change
 *   carries the same timestamp as that change. With `id` it orders the log and drives keyset
 *   pagination.
 * - `actor_*`, `action`, `entity_*`: who did what to what. Every filter column is indexed.
 * - `changes`, `metadata`: JSON, with configured keys redacted before they reach the database.
 */
export function buildAuditLogTable<TSchema extends string | undefined>(
  factory: TableFactory<TSchema>,
) {
  // Every name is built up front: Drizzle calls the extraConfig callback lazily.
  const tableName = factory.name("audit_log");
  const byTime = factory.name("audit_log_occurred_at_idx");
  const byAction = factory.name("audit_log_action_idx");
  const byEntity = factory.name("audit_log_entity_idx");
  const byActor = factory.name("audit_log_actor_idx");
  return factory.table(
    tableName,
    {
      id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
      occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
      actorType: text("actor_type").notNull(),
      actorId: text("actor_id"),
      actorLabel: text("actor_label"),
      action: text("action").notNull(),
      entityType: text("entity_type"),
      entityId: text("entity_id"),
      summary: text("summary"),
      changes: jsonb("changes").$type<Record<string, unknown>>(),
      metadata: jsonb("metadata").$type<Record<string, unknown>>(),
      ip: text("ip"),
      requestId: text("request_id"),
    },
    (t) => [
      index(byTime).on(t.occurredAt, t.id),
      index(byAction).on(t.action, t.occurredAt, t.id),
      index(byEntity).on(t.entityType, t.entityId, t.occurredAt, t.id),
      index(byActor).on(t.actorType, t.actorId, t.occurredAt, t.id),
    ],
  );
}

/** The audit-log table, as returned by `groundworkTables()`. */
export type AuditLogTable<TSchema extends string | undefined = string | undefined> = ReturnType<
  typeof buildAuditLogTable<TSchema>
>;

/** Column names the audit module's SQL relies on. */
export const AUDIT_LOG_COLUMNS = [
  "id",
  "occurred_at",
  "actor_type",
  "actor_id",
  "actor_label",
  "action",
  "entity_type",
  "entity_id",
  "summary",
  "changes",
  "metadata",
  "ip",
  "request_id",
] as const;
