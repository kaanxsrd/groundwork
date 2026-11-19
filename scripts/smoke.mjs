// Smoke test of the built package, the way a stranger would install it.
//
//   bun run db:up && bun run build && node scripts/smoke.mjs
//
// 1. Packs the package and installs the tarball (plus its peer) into a fresh project in the OS
//    temp directory, outside the repo, so nothing can resolve from the repo's node_modules.
// 2. Under plain Node (CI uses Node 22, the oldest supported):
//    - scripts/smoke/runtime.mjs imports every subpath and checks internals stay private;
//    - scripts/smoke/postgres.mjs migrates a fresh database from tests/migrations and runs real
//      rate-limit checks and audit entries through the published API.
// 3. Type-checks scripts/smoke/types.ts with several TypeScript versions and module resolutions.
//    Its expected-error lines prove the types are real and not silently `any`.
//
// SMOKE_TS_VERSIONS overrides the TypeScript versions, for example "5.9 7.0.2".
// TEST_DATABASE_URL overrides the maintenance database (default: the docker compose one).
// Plain JavaScript on purpose: it has to run on Node without a TypeScript loader.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = join(root, "scripts", "smoke");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "groundwork-smoke-"));
const app = join(work, "app");
const tsVersions = (process.env.SMOKE_TS_VERSIONS ?? "5.9 6.0.3 7.0.2")
  .split(/\s+/)
  .filter(Boolean);
const maintenanceUrl =
  process.env.TEST_DATABASE_URL || "postgres://groundwork:groundwork@127.0.0.1:54330/groundwork";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const minNode = Number(/\d+/.exec(pkg.engines.node)?.[0]);
if (nodeMajor < minNode) {
  throw new Error(`Node ${process.versions.node} is older than ${pkg.engines.node}`);
}

const run = (command, cwd, env = {}) =>
  execSync(command, { cwd, stdio: "pipe", encoding: "utf8", env: { ...process.env, ...env } });

function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  try {
    fn();
    console.log("ok");
  } catch (error) {
    console.log("FAILED");
    console.error(error.stdout ?? "", error.stderr ?? "", error.message);
    console.error(`The smoke project is left in ${work} for inspection.`);
    process.exit(1);
  }
}

/** Upstream errors that skipLibCheck: false surfaces in drizzle-orm's own declarations. */
const isUpstreamError = (line) =>
  line.replaceAll("\\", "/").startsWith("node_modules/drizzle-orm/");

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
  const dev = pkg.devDependencies;
  run(
    [
      "npm install --no-audit --no-fund --loglevel=error",
      `"${tarball}"`,
      `drizzle-orm@${dev["drizzle-orm"]}`,
      `postgres@${dev.postgres}`,
      `@types/pg@${dev["@types/pg"]}`,
      `@types/node@${dev["@types/node"]}`,
      ...tsVersions.map((version) => `"ts-${version}@npm:typescript@${version}"`),
    ].join(" "),
    app,
  );
  for (const file of ["runtime.mjs", "postgres.mjs", "types.ts"]) {
    copyFileSync(join(files, file), join(app, file));
  }
});

step(`import every subpath on Node ${process.versions.node}`, () => run("node runtime.mjs", app));

step(`rate limiting, audit and API keys against Postgres on Node ${process.versions.node}`, () =>
  run("node postgres.mjs", app, {
    SMOKE_DATABASE_URL: maintenanceUrl,
    SMOKE_MIGRATIONS: join(root, "tests", "migrations"),
  }),
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
            // Off, so our own .d.ts files are checked too, not just used.
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
      let output = "";
      try {
        output = run(`node "${tsc}" -p ${config}`, app);
      } catch (error) {
        output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
      }
      // With skipLibCheck off, drizzle-orm's declarations for dialects we never use report errors
      // under some TypeScript versions. Those are upstream's. Any other error (in types.ts, or in
      // node_modules/groundwork) fails the step.
      const errors = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line));
      const ours = errors.filter((line) => !isUpstreamError(line));
      if (ours.length > 0 || (errors.length === 0 && /error/i.test(output))) {
        throw new Error(ours.join("\n") || output);
      }
    });
  }
}

rmSync(work, { recursive: true, force: true });
console.log("Smoke test passed.");
