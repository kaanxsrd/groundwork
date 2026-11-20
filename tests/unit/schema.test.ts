import { describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { isGroundworkError } from "../../src/internal/errors.ts";
import { DEFAULT_PREFIX, groundworkTables } from "../../src/schema/index.ts";

const indexNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).indexes.map((index) => index.config.name);

describe("groundworkTables", () => {
  test('defaults to the "gw_" prefix in the default schema', () => {
    const { rateLimits } = groundworkTables();
    expect(DEFAULT_PREFIX).toBe("gw_");
    expect(getTableName(rateLimits)).toBe("gw_rate_limits");
    expect(getTableConfig(rateLimits).schema).toBeUndefined();
    expect(indexNames(rateLimits)).toEqual(["gw_rate_limits_expires_at_idx"]);
  });

  test("applies the prefix to tables and indexes alike", () => {
    expect(getTableName(groundworkTables({ prefix: "" }).rateLimits)).toBe("rate_limits");
    const { rateLimits, auditLog } = groundworkTables({ prefix: "app_gw_" });
    expect(getTableName(rateLimits)).toBe("app_gw_rate_limits");
    expect(indexNames(rateLimits)).toEqual(["app_gw_rate_limits_expires_at_idx"]);
    expect(getTableName(auditLog)).toBe("app_gw_audit_log");
    expect(indexNames(auditLog)).toEqual([
      "app_gw_audit_log_occurred_at_idx",
      "app_gw_audit_log_action_idx",
      "app_gw_audit_log_entity_idx",
      "app_gw_audit_log_actor_idx",
    ]);
  });

  test("the audit log is append-only by construction: identity ids, a default timestamp", () => {
    const { auditLog } = groundworkTables();
    const columns = Object.fromEntries(getTableConfig(auditLog).columns.map((c) => [c.name, c]));
    expect(columns.id?.primary).toBe(true);
    expect(columns.id?.generatedIdentity?.type).toBe("always");
    expect(columns.occurred_at?.hasDefault).toBe(true);
    expect(columns.changes?.getSQLType()).toBe("jsonb");
    expect(Object.keys(columns)).toEqual([
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
    ]);
  });

  test("puts the tables in a Postgres schema and returns it for export", () => {
    const tables = groundworkTables({ schema: "ops" });
    expect(getTableConfig(tables.rateLimits).schema).toBe("ops");
    expect(getTableConfig(tables.auditLog).schema).toBe("ops");
    expect(tables.schema.schemaName).toBe("ops");
    expect("schema" in groundworkTables()).toBe(false);
  });

  test("the schema object is only in the type when a schema is configured", () => {
    const withSchema: "ops" = groundworkTables({ schema: "ops" }).schema.schemaName;
    // @ts-expect-error there is no schema to export without the option
    const without = groundworkTables().schema;
    expect([withSchema, without]).toEqual(["ops", undefined]);
  });

  test("columns have the types the rate limiter relies on", () => {
    const { rateLimits } = groundworkTables();
    type Row = typeof rateLimits.$inferSelect;
    const row: Row = {
      key: "k",
      rule: "r",
      used: 1.5,
      updatedAt: new Date(),
      expiresAt: new Date(),
    };
    // @ts-expect-error used is a number
    const bad: Row = { ...row, used: "1" };
    expect([row, bad]).toHaveLength(2);
    const columns = getTableConfig(rateLimits).columns.map((c) => [
      c.name,
      c.getSQLType(),
      c.notNull,
    ]);
    expect(columns).toEqual([
      ["key", "text", true],
      ["rule", "text", true],
      ["used", "double precision", true],
      ["updated_at", "timestamp with time zone", true],
      ["expires_at", "timestamp with time zone", true],
    ]);
  });

  test("builds the idempotency-key table with every name prefixed", () => {
    const { idempotencyKeys } = groundworkTables({ prefix: "app_" });
    expect(getTableName(idempotencyKeys)).toBe("app_idempotency_keys");
    expect(indexNames(idempotencyKeys)).toEqual(["app_idempotency_keys_expires_at_idx"]);
    const columns = getTableConfig(idempotencyKeys).columns.map((c) => [
      c.name,
      c.getSQLType(),
      c.notNull,
    ]);
    expect(columns).toEqual([
      ["key", "text", true],
      ["scope", "text", true],
      ["fingerprint", "text", true],
      ["locked_by", "text", false],
      ["locked_until", "timestamp with time zone", false],
      ["response", "text", false],
      ["created_at", "timestamp with time zone", true],
      ["completed_at", "timestamp with time zone", false],
      ["expires_at", "timestamp with time zone", true],
    ]);
    expect(getTableConfig(idempotencyKeys).primaryKeys).toEqual([]);
    expect(getTableConfig(idempotencyKeys).columns.find((c) => c.name === "key")?.primary).toBe(
      true,
    );
  });

  test.each([["GW_"], ["1gw_"], ["gw-"], [" gw"], ["gw_é"], [5]])(
    "rejects the prefix %p",
    (prefix) => {
      expect(() => groundworkTables({ prefix: prefix as string })).toThrow(/Invalid table prefix/);
    },
  );

  test("rejects a prefix that would make a name longer than Postgres allows", () => {
    expect(() => groundworkTables({ prefix: "p".repeat(40) })).toThrow(/too long/);
    expect(() => groundworkTables({ prefix: "p".repeat(30) })).not.toThrow();
  });

  test.each([["Ops"], ["pg_ops"], [""], ["o".repeat(64)], ["my-schema"]])(
    "rejects the schema %p",
    (schema) => {
      let caught: unknown;
      try {
        groundworkTables({ schema });
      } catch (error) {
        caught = error;
      }
      expect(isGroundworkError(caught) && caught.code).toBe("invalid_config");
    },
  );
});
