import { describe, expect, test } from "bun:test";
import { rowsOf } from "../../src/internal/db.ts";

describe("rowsOf", () => {
  test("takes postgres-js arrays and node-postgres { rows } as they are", () => {
    const rows = [{ used_at: 1, id: "a" }];
    expect(rowsOf(rows)).toBe(rows);
    expect(rowsOf({ rows })).toBe(rows);
    expect(rowsOf([])).toEqual([]);
  });

  test("undoes postgres-js's camel, pascal and kebab column transforms", () => {
    const expected = [{ used_at: 1, expires_at: 2, id: "a" }];
    expect(rowsOf([{ usedAt: 1, expiresAt: 2, id: "a" }])).toEqual(expected);
    expect(rowsOf([{ UsedAt: 1, ExpiresAt: 2, Id: "a" }])).toEqual(expected);
    expect(rowsOf([{ "used-at": 1, "expires-at": 2, id: "a" }])).toEqual(expected);
  });

  test("leaves values alone, JSON text included", () => {
    expect(rowsOf([{ recordText: '{"orderId":1}' }])).toEqual([{ record_text: '{"orderId":1}' }]);
  });

  test("refuses anything else", () => {
    expect(() => rowsOf(null)).toThrow(TypeError);
    expect(() => rowsOf({ count: 1 })).toThrow(TypeError);
  });
});
