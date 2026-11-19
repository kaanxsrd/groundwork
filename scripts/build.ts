// Builds dist/ with the TypeScript compiler: unbundled ESM, .d.ts files and source maps,
// one output file per source file. Then checks that every target in package.json "exports" exists.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });

const tsc = Bun.spawnSync(["bun", "x", "tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);

type ExportTarget = string | { readonly [condition: string]: ExportTarget };
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, ExportTarget>;
};

const missing: string[] = [];
const visit = (target: ExportTarget): void => {
  if (typeof target === "string") {
    if (!existsSync(join(root, target))) missing.push(target);
  } else {
    for (const value of Object.values(target)) visit(value);
  }
};
for (const target of Object.values(pkg.exports)) visit(target);

if (missing.length > 0) {
  console.error(
    `package.json exports point at files the build did not produce:\n  ${missing.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`Built dist/ (${Object.keys(pkg.exports).length} export entries checked).`);
