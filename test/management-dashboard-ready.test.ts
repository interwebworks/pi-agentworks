import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  managementDashboardReadyPath,
  readManagementDashboardReadyProof,
  writeManagementDashboardReadyProof,
} from "../src/infrastructure/herdr/management-dashboard-ready.ts";

test("dashboard readiness is private authenticated-read process evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentworks-dashboard-ready-"));
  try {
    const path = managementDashboardReadyPath(directory);
    const written = writeManagementDashboardReadyProof(path, "run-1");
    assert.equal(written.runId, "run-1");
    assert.equal(written.processId, process.pid);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readManagementDashboardReadyProof(path), written);

    chmodSync(path, 0o644);
    assert.equal(readManagementDashboardReadyProof(path), null);
    chmodSync(path, 0o600);
    writeFileSync(path, "{}", "utf8");
    assert.equal(readManagementDashboardReadyProof(path), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
