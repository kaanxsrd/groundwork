// Smoke test of the built package, the way a stranger would install it.
//
//   bun run build && node scripts/smoke.mjs
//
// 1. Packs the package and installs the tarball (plus its peer) into a fresh project in the OS
//    temp directory, outside the repo, so nothing can resolve from the repo node_modules.
// 2. Imports every subpath under plain Node (CI runs this on Node 22, the oldest supported).
// 3. Type-checks a consumer file with several TypeScript versions and module resolutions, using
//    @ts-expect-error lines to prove the types are real and not silently `any`.
//
// SMOKE_TS_VERSIONS overrides the TypeScript versions, for example "5.9 7.0.2".
// Plain JavaScript on purpose: it has to run on Node without a TypeScript loader.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "groundwork-smoke-"));
const app = join(work, "app");
const tsVersions = (process.env.SMOKE_TS_VERSIONS ?? "5.9 6.0.3 7.0.2")
  .split(/\s+/)
  .filter(Boolean);
const subpaths = Object.keys(pkg.exports).filter((key) => key !== "./package.json");

const nodeMajor = Number(process.versions.node.split(".")[0]);
const minNode = Number(/\d+/.exec(pkg.engines.node)?.[0]);
if (nodeMajor < minNode)
  throw new Error(`Node ${process.versions.node} is older than ${pkg.engines.node}`);

const run = (command, cwd) => execSync(command, { cwd, stdio: "pipe", encoding: "utf8" });

function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  try {
    fn();
    console.log("ok");
  } catch (error) {
    console.log("FAILED");
    console.error(error.stdout ?? "", error.stderr ?? "", error.message);
    process.exit(1);
  }
}

mkdirSync(app, { recursive: true });

let tarball = "";
step("pack", () => {
  const [packed] = JSON.parse(run(`npm pack --json --pack-destination "${work}"`, root));
  tarball = join(work, packed.filename);
});

step(`install into a fresh project (TypeScript ${tsVersions.join(", ")})`, () => {
  writeFileSync(
    join(app, "package.json"),
    JSON.stringify({ name: "smoke-app", private: true, type: "module" }, null, 2),
  );
  const typescripts = tsVersions.map((version) => `"ts-${version}@npm:typescript@${version}"`);
  run(
    [
      "npm install --no-audit --no-fund --loglevel=error",
      `"${tarball}"`,
      `drizzle-orm@${pkg.devDependencies["drizzle-orm"]}`,
      `@types/node@${pkg.devDependencies["@types/node"]}`,
      ...typescripts,
    ].join(" "),
    app,
  );
});

writeFileSync(
  join(app, "runtime.mjs"),
  `import assert from "node:assert/strict";
import * as root from "groundwork";

assert.equal(typeof root.GroundworkError, "function");
const error = new root.GroundworkError("invalid_config", "x");
assert.equal(root.isGroundworkError(error), true);
assert.equal(error.code, "invalid_config");

for (const subpath of ${JSON.stringify(subpaths)}) {
  await import(subpath === "." ? "groundwork" : "groundwork/" + subpath.slice(2));
}

// Internals stay private: only the subpaths in "exports" resolve.
await assert.rejects(import("groundwork/dist/internal/crypto.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
await assert.rejects(import("groundwork/internal/crypto"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
`,
);
step(`import every subpath on Node ${process.versions.node}`, () => run("node runtime.mjs", app));

writeFileSync(
  join(app, "types.ts"),
  `import { type Duration, GroundworkError, type GroundworkErrorCode, isGroundworkError, type Logger } from "groundwork";
${subpaths
  .filter((subpath) => subpath !== ".")
  .map((subpath, i) => `import * as m${i} from "groundwork/${subpath.slice(2)}";`)
  .join("\n")}

const window: Duration = "15m";
// @ts-expect-error a duration needs a unit
const noUnit: Duration = "15";
// @ts-expect-error unknown error code
new GroundworkError("not_a_code", "x");
const code: GroundworkErrorCode = new GroundworkError("invalid_argument", "x").code;
const logger: Logger = console;
const maybe: unknown = new Error("x");
if (isGroundworkError(maybe)) {
  const narrowed: GroundworkErrorCode = maybe.code;
  void narrowed;
}
void [window, noUnit, code, logger${subpaths
    .filter((s) => s !== ".")
    .map((_, i) => `, m${i}`)
    .join("")}];
`,
);

const resolutions = [
  { module: "nodenext", moduleResolution: "nodenext" },
  { module: "preserve", moduleResolution: "bundler" },
];
for (const version of tsVersions) {
  for (const { module, moduleResolution } of resolutions) {
    step(`types with TypeScript ${version}, moduleResolution ${moduleResolution}`, () => {
      const config = `tsconfig.${moduleResolution}.json`;
      writeFileSync(
        join(app, config),
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            exactOptionalPropertyTypes: true,
            // Off: our .d.ts files must be valid on their own, not just usable.
            skipLibCheck: false,
            target: "es2022",
            module,
            moduleResolution,
            types: ["node"],
          },
          files: ["types.ts"],
        }),
      );
      const tsc = join(app, "node_modules", `ts-${version}`, "bin", "tsc");
      run(`node "${tsc}" -p ${config}`, app);
    });
  }
}

rmSync(work, { recursive: true, force: true });
console.log("Smoke test passed.");
