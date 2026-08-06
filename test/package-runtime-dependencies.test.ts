import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test("detached controller runtime dependencies are production dependencies", () => {
  assert.equal(packageManifest.dependencies?.typebox, "^1.1.38");
  assert.equal(packageManifest.devDependencies?.typebox, undefined);
});
