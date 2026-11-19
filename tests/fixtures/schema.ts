// The Drizzle schema the integration tests run against. drizzle-kit generates
// tests/migrations from this file, exactly as an app's drizzle-kit would from its own schema.
// Phase 1 replaces the probe table with the groundwork table factories.
import { bigserial, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** A throwaway table that proves the harness creates tables and talks to Postgres. */
export const harnessProbe = pgTable("gw_harness_probe", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
