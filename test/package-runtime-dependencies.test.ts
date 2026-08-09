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
  bundledDependencies?: string[];
};

test("detached controller runtime dependencies are production dependencies", () => {
  const dependencies = packageManifest.dependencies ?? {};
  const devDependencies = packageManifest.devDependencies ?? {};
  assert.equal(dependencies.typebox, "^1.1.38");
  assert.equal(dependencies.jiti, "2.7.0");
  assert.equal(dependencies["pi-subagents"], "0.38.0");
  assert.deepEqual(packageManifest.bundledDependencies, ["pi-subagents"]);
  assert.equal(devDependencies.typebox, undefined);
  assert.equal(devDependencies.jiti, undefined);
  assert.equal(devDependencies["pi-subagents"], undefined);
});
