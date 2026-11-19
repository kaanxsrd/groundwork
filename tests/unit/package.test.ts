import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, string | { types: string; default: string }>;
  peerDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
  sideEffects: boolean;
  type: string;
};

const SUBPATHS = [
  ".",
  "./schema",
  "./rate-limit",
  "./audit",
  "./api-keys",
  "./jobs",
  "./idempotency",
  "./next",
  "./testing",
];

describe("package.json", () => {
  test("exports exactly the subpaths in PLAN.md", () => {
    expect(Object.keys(pkg.exports).filter((key) => key !== "./package.json")).toEqual(SUBPATHS);
  });

  test("every export maps to a source entry point with matching types", () => {
    for (const subpath of SUBPATHS) {
      const target = pkg.exports[subpath];
      if (typeof target !== "object") throw new Error(`${subpath} must have conditions`);
      expect(Object.keys(target)).toEqual(["types", "default"]);
      const source = target.default.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
      expect(existsSync(join(root, source))).toBe(true);
      expect(target.types).toBe(target.default.replace(/\.js$/, ".d.ts"));
    }
  });

  test("is ESM only, side-effect free, with drizzle-orm as the only peer and no runtime deps", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);
    expect(Object.keys(pkg.peerDependencies)).toEqual(["drizzle-orm"]);
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  test("every entry point loads", async () => {
    for (const subpath of SUBPATHS) {
      const file = subpath === "." ? "index.ts" : `${subpath.slice(2)}/index.ts`;
      await import(join(root, "src", file));
    }
    const root_ = await import(join(root, "src", "index.ts"));
    expect(Object.keys(root_).sort()).toEqual(["GroundworkError", "isGroundworkError"]);
  });
});
