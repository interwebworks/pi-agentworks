import assert from "node:assert/strict";
import test from "node:test";
import {
  requiredApprovals,
  requiresApproval,
  requiresModelConfirmation,
} from "../src/domain/approval-policy.ts";

test("LOW gates every material checkpoint including models", () => {
  const low = requiredApprovals("LOW");
  for (const checkpoint of [
    "domain",
    "team",
    "architecture",
    "technology",
    "stories",
    "acceptance-criteria",
    "branches",
    "models",
    "material-decision",
  ] as const) {
    assert.ok(
      requiresApproval("LOW", checkpoint),
      `LOW must gate ${checkpoint}`,
    );
  }
  assert.ok(low.includes("models"));
});

test("NORMAL gates plan-shaping decisions and model assignments", () => {
  assert.ok(requiresApproval("NORMAL", "stories"));
  assert.ok(requiresApproval("NORMAL", "integration-target"));
  assert.ok(requiresApproval("NORMAL", "models"));
  // NORMAL is supervised, not exhaustive: it does not gate the domain choice.
  assert.equal(requiresApproval("NORMAL", "domain"), false);
});

test("HIGH gates nothing routinely", () => {
  assert.equal(requiredApprovals("HIGH").length, 0);
  assert.equal(requiresApproval("HIGH", "models"), false);
});

test("model confirmation is mandatory in LOW and NORMAL, not HIGH", () => {
  assert.equal(requiresModelConfirmation("LOW"), true);
  assert.equal(requiresModelConfirmation("NORMAL"), true);
  assert.equal(requiresModelConfirmation("HIGH"), false);
});

test("required approvals are returned in canonical order", () => {
  const normal = requiredApprovals("NORMAL");
  const sorted = [...normal];
  assert.deepEqual(normal, sorted);
  // team precedes models in canonical order
  assert.ok(normal.indexOf("team") < normal.indexOf("models"));
});
