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
  name: string;
  repository: { type: string; url: string };
  publishConfig: { access: string };
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
  test("is the public scoped package, linked to the repository that publishes it", () => {
    expect(pkg.name).toBe("@vantedev/groundwork");
    // Scoped packages are private unless published with access public.
    expect(pkg.publishConfig.access).toBe("public");
    // npm provenance checks this against the GitHub repository that ran the publish.
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/kaanxsrd/groundwork.git",
    });
  });

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

  test("each entry point exports exactly its public runtime API", async () => {
    // Types are checked by the smoke test; this pins the values, so an accidental export shows up.
    const expected: Record<string, string[]> = {
      ".": ["GroundworkError", "createGroundwork", "isGroundworkError", "pinoLogger"],
      "./schema": ["DEFAULT_PREFIX", "groundworkTables"],
      "./rate-limit": ["createRateLimiter", "memoryStore", "redisStore"],
      "./audit": ["DEFAULT_REDACT", "REDACTED", "createAuditLog", "diff"],
      "./api-keys": ["API_KEY_AUDIT_ACTIONS", "apiKeyAuditEvent", "createApiKeys"],
      "./jobs": ["backoffDelayMs", "createJobs"],
      "./idempotency": [
        "IDEMPOTENCY_KEY_HEADER",
        "REPLAYED_HEADER",
        "createIdempotency",
        "parseIdempotencyKey",
      ],
      "./next": ["createRouteHelpers", "getClientIp", "jobsRoute"],
      "./testing": ["createTestClock"],
    };
    for (const subpath of SUBPATHS) {
      const file = subpath === "." ? "index.ts" : `${subpath.slice(2)}/index.ts`;
      const module = await import(join(root, "src", file));
      expect([subpath, Object.keys(module).sort()]).toEqual([subpath, expected[subpath] ?? []]);
    }
  });
});
