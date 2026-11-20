// End-to-end test of examples/next-app and of the README quickstart, the way a stranger would
// use them: against the packed package, in projects outside the repo, built with `next build` and
// driven over HTTP by `next start`.
//
//   bun run db:up && bun run build && node scripts/example.mjs        # both
//   node scripts/example.mjs example                                 # just examples/next-app
//   node scripts/example.mjs quickstart                              # just the README quickstart
//   node scripts/example.mjs generate     # rewrite examples/next-app/drizzle after a schema change
//   node scripts/example.mjs dev          # run examples/next-app with `next dev` on this checkout
//
// - example: copies examples/next-app, installs the tarball, checks its migrations are up to date,
//   migrates a fresh database, builds, starts, and runs scripts/example/example-checks.mjs.
// - quickstart: creates an app with create-next-app (the version examples/next-app pins), writes
//   every README code block that has a filename="…" into it, runs the README's npm and
//   drizzle-kit commands, builds, starts, and runs scripts/example/quickstart-checks.mjs.
//
// TEST_DATABASE_URL overrides the maintenance database (default: the docker compose one).
// Plain JavaScript on purpose: it has to run on Node without a TypeScript loader.
import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleDir = join(root, "examples", "next-app");
const packageName = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
const mode = process.argv[2] ?? "all";
const modes = ["all", "example", "quickstart", "generate", "dev"];
if (!modes.includes(mode)) throw new Error(`Usage: node scripts/example.mjs [${modes.join("|")}]`);
const maintenanceUrl =
  process.env.TEST_DATABASE_URL || "postgres://groundwork:groundwork@127.0.0.1:54330/groundwork";
const work = mkdtempSync(join(tmpdir(), "groundwork-example-"));
const cleanups = [];

// Run through `npx -p node@22 -- node scripts/example.mjs`, npm leaves npm_config_package in the
// environment, and every npx below would then run its command inside that package instead.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_config_package"),
);

const run = (command, cwd, env = {}) =>
  execSync(command, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
    env: { ...baseEnv, NEXT_TELEMETRY_DISABLED: "1", ...env },
    maxBuffer: 64 * 1024 * 1024,
  });

async function step(name, fn) {
  process.stdout.write(`- ${name} ... `);
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return result;
  } catch (error) {
    console.log("FAILED");
    console.error(error.stdout ?? "", error.stderr ?? "", error.stack ?? error.message);
    console.error(`The projects are left in ${work} for inspection.`);
    await cleanup();
    process.exit(1);
  }
}

async function cleanup() {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch (error) {
      console.error("cleanup:", error.message);
    }
  }
  cleanups.length = 0;
}

const secret = () => randomBytes(32).toString("base64url");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A fresh database, dropped when the script ends. */
async function createDatabase(label) {
  const admin = postgres(maintenanceUrl, { max: 1, onnotice: () => {} });
  const name = `gw_${label}_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
  await admin.unsafe(`create database "${name}"`);
  cleanups.push(async () => {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  });
  const url = new URL(maintenanceUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** `next start` (no npx in between, so killing the process stops the server). */
async function startNext(app, env) {
  const port = await freePort();
  const next = join(app, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [next, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: app,
    env: { ...baseEnv, NEXT_TELEMETRY_DISABLED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  cleanups.push(async () => {
    child.kill();
    await stopped;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`next start exited:\n${output}`);
    try {
      await fetch(base);
      return { base, output: () => output };
    } catch {
      if (Date.now() > deadline) throw new Error(`next start did not answer:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

let tarball = "";
async function pack() {
  await step("build and pack groundwork", () => {
    run("bun run build", root);
    const [packed] = JSON.parse(run(`npm pack --json --pack-destination "${work}"`, root));
    tarball = join(work, packed.filename);
  });
}

/** Copies examples/next-app, with groundwork installed from the tarball. */
async function installExample(target) {
  await step("copy examples/next-app and install the tarball", () => {
    cpSync(exampleDir, target, {
      recursive: true,
      filter: (source) => !/[\\/](node_modules|\.next|\.env\.local)$/.test(source),
    });
    const pkgPath = join(target, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies[packageName] = pathToFileURL(tarball).href;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    run("npm install --no-audit --no-fund --loglevel=error", target);
  });
}

async function example() {
  const app = join(work, "next-app");
  await installExample(app);
  const env = {
    DATABASE_URL: await createDatabase("example"),
    GROUNDWORK_SECRET: secret(),
    CRON_SECRET: secret(),
    ADMIN_SECRET: secret(),
  };
  await step("its migrations match its schema", () => {
    const output = run("npx drizzle-kit generate", app, env);
    if (!/No schema changes/i.test(output)) {
      throw new Error(
        `examples/next-app/drizzle is out of date. Run: node scripts/example.mjs generate\n${output}`,
      );
    }
  });
  await step("drizzle-kit migrate", () => run("npx drizzle-kit migrate", app, env));
  await step("next build", () => run("npx next build", app, env));
  const server = await step("next start", () => startNext(app, env));
  await step("every module over HTTP (scripts/example/example-checks.mjs)", async () => {
    const { runExampleChecks } = await import("./example/example-checks.mjs");
    await runExampleChecks({ base: server.base, env });
  });
  await cleanup();
}

/** The README's quickstart: its sh commands and its files with filename="…". */
function readQuickstart() {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const start = readme.indexOf("## Quickstart");
  const end = readme.indexOf("\n## ", start + 1);
  if (start === -1 || end === -1) throw new Error("README.md has no ## Quickstart section.");
  const section = readme.slice(start, end);
  const blocks = [...section.matchAll(/```(\w+)([^\n]*)\n([\s\S]*?)```/g)].map((match) => ({
    lang: match[1],
    filename: /filename="([^"]+)"/.exec(match[2])?.[1],
    code: match[3],
  }));
  const files = blocks.filter((block) => block.filename);
  const commands = blocks
    .filter((block) => block.lang === "sh")
    .flatMap((block) => block.code.split("\n"))
    .map((line) => line.trim())
    .filter((line) => /^(npm install|npx drizzle-kit)\b/.test(line));
  if (files.length < 4 || commands.length < 4) {
    throw new Error("Could not find the quickstart's files and commands in README.md.");
  }
  return { files, commands };
}

async function quickstart() {
  const { files, commands } = readQuickstart();
  const nextVersion = JSON.parse(readFileSync(join(exampleDir, "package.json"), "utf8"))
    .dependencies.next;
  const app = join(work, "quickstart");
  await step(`create-next-app@${nextVersion}`, () =>
    run(
      `npx -y create-next-app@${nextVersion} quickstart --ts --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*" --use-npm --disable-git --skip-install --no-agent-feedback --yes`,
      work,
    ),
  );
  const env = {
    DATABASE_URL: await createDatabase("quickstart"),
    GROUNDWORK_SECRET: secret(),
    CRON_SECRET: secret(),
  };
  // What the README tells you to put in .env.local.
  writeFileSync(
    join(app, ".env.local"),
    Object.entries(env)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n"),
  );
  for (const command of commands.filter((c) => c.startsWith("npm install"))) {
    // The README installs groundwork from npm; this installs the tarball under test instead.
    const local = command.replace(` ${packageName}`, ` "${pathToFileURL(tarball).href}"`);
    if (command.includes(packageName) && local === command)
      throw new Error(`Could not swap ${packageName} in: ${command}`);
    await step(command, () => run(`${local} --no-audit --no-fund --loglevel=error`, app));
  }
  await step(`write the README's ${files.length} files`, () => {
    for (const file of files) {
      mkdirSync(dirname(join(app, file.filename)), { recursive: true });
      writeFileSync(join(app, file.filename), file.code);
    }
  });
  // The env comes from .env.local only, as it would for someone following the README.
  for (const command of commands.filter((c) => c.startsWith("npx drizzle-kit"))) {
    await step(command, () => run(command, app));
  }
  await step("next build", () => run("npx next build", app));
  const server = await step("next start", () => startNext(app, {}));
  await step("the quickstart over HTTP (scripts/example/quickstart-checks.mjs)", async () => {
    const { runQuickstartChecks } = await import("./example/quickstart-checks.mjs");
    await runQuickstartChecks({ base: server.base, env, app });
  });
  await cleanup();
}

async function generate() {
  const app = join(work, "next-app");
  await installExample(app);
  await step("drizzle-kit generate", () => {
    rmSync(join(app, "drizzle"), { recursive: true, force: true });
    console.log(run("npx drizzle-kit generate --name init", app, { DATABASE_URL: maintenanceUrl }));
    rmSync(join(exampleDir, "drizzle"), { recursive: true, force: true });
    cpSync(join(app, "drizzle"), join(exampleDir, "drizzle"), { recursive: true });
  });
  console.log(`Wrote ${join(exampleDir, "drizzle")}.`);
}

async function dev() {
  const app = join(work, "next-app");
  await installExample(app);
  const env = {
    DATABASE_URL: process.env.DATABASE_URL || (await createDatabase("dev")),
    GROUNDWORK_SECRET: process.env.GROUNDWORK_SECRET || secret(),
    CRON_SECRET: process.env.CRON_SECRET || secret(),
    ADMIN_SECRET: process.env.ADMIN_SECRET || secret(),
  };
  await step("drizzle-kit migrate", () => run("npx drizzle-kit migrate", app, env));
  console.log("Environment for this run:");
  for (const [name, value] of Object.entries(env)) console.log(`  ${name}=${value}`);
  const next = join(app, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [next, "dev"], {
    cwd: app,
    env: { ...baseEnv, ...env },
    stdio: "inherit",
  });
  await new Promise((resolve) => child.once("exit", resolve));
  await cleanup();
}

await pack();
if (mode === "example" || mode === "all") await example();
if (mode === "quickstart" || mode === "all") await quickstart();
if (mode === "generate") await generate();
if (mode === "dev") await dev();
rmSync(work, { recursive: true, force: true });
if (mode === "all" || mode === "example" || mode === "quickstart")
  console.log("Example checks passed.");
