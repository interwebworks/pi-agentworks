import assert from "node:assert/strict";
import test from "node:test";
import { parseManagementProcessArguments } from "../src/management/process-entry.ts";

test("management process accepts only the exact dashboard identity arguments", () => {
  assert.deepEqual(
    parseManagementProcessArguments([
      "--runtime-root",
      "/runtime",
      "--run-id",
      "run-1",
      "--ready-path",
      "/runtime/run-1/management-dashboard-ready.json",
    ]),
    {
      runtimeRoot: "/runtime",
      runId: "run-1",
      readyPath: "/runtime/run-1/management-dashboard-ready.json",
    },
  );
  assert.throws(
    () =>
      parseManagementProcessArguments([
        "--runtime-root",
        "/runtime",
        "--run-id",
        "run-1",
        "--ready-path",
        "/runtime/run-1/ready.json",
        "--extra",
        "unsafe",
      ]),
    /unknown argument/u,
  );
  assert.throws(
    () => parseManagementProcessArguments(["--run-id", "run-1"]),
    /requires/u,
  );
  assert.throws(
    () =>
      parseManagementProcessArguments([
        "--runtime-root",
        "/runtime",
        "--run-id",
        "run-1",
        "--ready-path",
        "/tmp/spoofed-ready.json",
      ]),
    /private run runtime/u,
  );
});
