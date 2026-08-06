import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AGENTWORKS_RUNTIME_ROOT,
  InvalidAgentworksRuntimeRootError,
  resolveAgentworksRuntimeRoot,
} from "../src/infrastructure/controller/runtime-root.ts";

test("parent sessions use a private Pi runtime root by default", () => {
  assert.equal(
    resolveAgentworksRuntimeRoot({}),
    DEFAULT_AGENTWORKS_RUNTIME_ROOT,
  );
  assert.match(
    DEFAULT_AGENTWORKS_RUNTIME_ROOT,
    /\.pi\/agent\/agentworks\/runtime$/u,
  );
});

test("explicit runtime roots are resolved and empty overrides fail closed", () => {
  assert.equal(
    resolveAgentworksRuntimeRoot({ AGENTWORKS_RUNTIME_ROOT: "./runtime" }),
    `${process.cwd()}/runtime`,
  );
  assert.throws(
    () => resolveAgentworksRuntimeRoot({ AGENTWORKS_RUNTIME_ROOT: "  " }),
    (error: unknown) =>
      error instanceof InvalidAgentworksRuntimeRootError &&
      error.message.includes("cannot be empty"),
  );
});
