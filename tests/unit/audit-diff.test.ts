import { describe, expect, test } from "bun:test";
import { type AuditDiff, diff } from "../../src/audit/index.ts";

describe("diff", () => {
  test("returns only the fields that changed, as [before, after]", () => {
    expect(
      diff({ title: "Old", body: "same", views: 1 }, { title: "New", body: "same", views: 2 }),
    ).toEqual({ title: ["Old", "New"], views: [1, 2] });
  });

  test("returns {} when nothing changed", () => {
    expect(diff({ a: 1, b: [1, 2], c: { d: 1 } }, { a: 1, b: [1, 2], c: { d: 1 } })).toEqual({});
  });

  test("compares nested values deeply but reports the field whole", () => {
    expect(
      diff(
        { tags: ["a", "b"], meta: { seo: { title: "x" } } },
        { tags: ["a", "b"], meta: { seo: { title: "y" } } },
      ),
    ).toEqual({ meta: [{ seo: { title: "x" } }, { seo: { title: "y" } }] });
    expect(diff({ tags: ["a", "b"] }, { tags: ["b", "a"] })).toEqual({
      tags: [
        ["a", "b"],
        ["b", "a"],
      ],
    });
  });

  test("compares dates by time, not identity", () => {
    const at = "2026-01-01T00:00:00Z";
    expect(diff({ at: new Date(at) }, { at: new Date(at) })).toEqual({});
    const later = new Date("2026-01-02T00:00:00Z");
    expect(diff({ at: new Date(at) }, { at: later })).toEqual({ at: [new Date(at), later] });
  });

  test("handles NaN, bytes, maps and sets", () => {
    expect(diff({ n: Number.NaN }, { n: Number.NaN })).toEqual({});
    expect(diff({ b: Buffer.from("ab") }, { b: Buffer.from("ab") })).toEqual({});
    expect(Object.keys(diff({ b: Buffer.from("ab") }, { b: Buffer.from("ac") }))).toEqual(["b"]);
    expect(diff({ m: new Map([["a", 1]]) }, { m: new Map([["a", 1]]) })).toEqual({});
    expect(Object.keys(diff({ s: new Set([1]) }, { s: new Set([2]) }))).toEqual(["s"]);
    expect(Object.keys(diff({ x: new Set([1]) }, { x: [1] }))).toEqual(["x"]);
  });

  test("a missing side is null: creates, deletes and added or removed fields", () => {
    expect(diff(null, { title: "New", draft: true })).toEqual({
      title: [null, "New"],
      draft: [null, true],
    });
    expect(diff({ title: "Gone" }, undefined)).toEqual({ title: ["Gone", null] });
    expect(diff<Record<string, unknown>>({ a: 1 }, { b: 2 })).toEqual({
      a: [1, null],
      b: [null, 2],
    });
    expect(diff(null, null)).toEqual({});
  });

  test("ignore leaves fields out even when they changed", () => {
    const before = { title: "a", updatedAt: new Date(1) };
    const after = { title: "a", updatedAt: new Date(2) };
    expect(diff(before, after, { ignore: ["updatedAt"] })).toEqual({});
  });

  test("never modifies its inputs", () => {
    const before = Object.freeze({ a: Object.freeze([1]) });
    const after = Object.freeze({ a: Object.freeze([2]) });
    expect(() => diff(before, after)).not.toThrow();
  });

  test("is typed from the row", () => {
    type Post = { title: string; views: number };
    const changes: AuditDiff<Post> = diff<Post>({ title: "a", views: 1 }, { title: "b", views: 1 });
    const title: [string | null, string | null] | undefined = changes.title;
    // @ts-expect-error ignore only accepts the row's keys
    diff<Post>({ title: "a", views: 1 }, null, { ignore: ["nope"] });
    expect(title).toEqual(["a", "b"]);
  });
});
