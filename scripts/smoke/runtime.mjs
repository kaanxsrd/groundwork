// Runs in the smoke project under plain Node: every subpath loads and internals stay private.
import assert from "node:assert/strict";
import * as root from "@vante/groundwork";
import pkg from "@vante/groundwork/package.json" with { type: "json" };

assert.equal(typeof root.GroundworkError, "function");
assert.equal(typeof root.createGroundwork, "function");
const error = new root.GroundworkError("invalid_config", "x");
assert.equal(root.isGroundworkError(error), true);
assert.equal(error.code, "invalid_config");

for (const subpath of Object.keys(pkg.exports).filter((key) => key !== "./package.json")) {
  await import(subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`);
}

// Only the subpaths in "exports" resolve.
await assert.rejects(import("@vante/groundwork/dist/internal/crypto.js"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
await assert.rejects(import("@vante/groundwork/internal/crypto"), {
  code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
});
