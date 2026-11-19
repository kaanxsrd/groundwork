// Fails when tests/fixtures/schema.ts has changed without a regenerated migration.
// drizzle-kit runs against a temporary copy of tests/migrations, so the working tree is never touched.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const migrations = join(root, "tests", "migrations");

function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path).replaceAll("\\", "/"), readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return files;
}

/** Returns the migration files drizzle-kit would add or change, or throws if it failed. */
function driftedFiles(scratch: string): string[] {
  cpSync(migrations, scratch, { recursive: true });
  const before = snapshot(scratch);
  const result = Bun.spawnSync(
    [
      "bun",
      "x",
      "drizzle-kit",
      "generate",
      "--dialect",
      "postgresql",
      "--schema",
      "./tests/fixtures/schema.ts",
      "--out",
      // Relative on purpose: on Windows drizzle-kit prefixes absolute --out paths with the cwd.
      relative(root, scratch).replaceAll("\\", "/"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  // drizzle-kit can exit 0 after a crash, so require one of its two success messages too.
  if (result.exitCode !== 0 || !/No schema changes|Your SQL migration file/.test(output)) {
    throw new Error(`drizzle-kit generate failed:\n${output}`);
  }
  const after = snapshot(scratch);
  return [...after.keys()].filter((file) => before.get(file) !== after.get(file));
}

// tmp/ is gitignored and ignored by Biome.
mkdirSync(join(root, "tmp"), { recursive: true });
const scratch = mkdtempSync(join(root, "tmp", "drift-"));
try {
  const changed = driftedFiles(scratch);
  if (changed.length > 0) {
    console.error(
      `tests/fixtures/schema.ts changed without a migration. Run \`bun run db:generate\` and commit:\n  ${changed.join("\n  ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("Migrations are up to date with tests/fixtures/schema.ts.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
