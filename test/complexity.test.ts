import assert from "node:assert/strict";
import test from "node:test";
import {
  getComplexityPolicy,
  parseComplexityMode,
} from "../src/domain/complexity.ts";

test("complexity modes normalize user input", () => {
  assert.equal(parseComplexityMode(" low "), "LOW");
  assert.equal(parseComplexityMode("Normal"), "NORMAL");
  assert.equal(parseComplexityMode("HIGH"), "HIGH");
});

test("complexity modes reject unknown values", () => {
  assert.throws(
    () => parseComplexityMode("unlimited"),
    /Unknown Agentworks complexity mode/u,
  );
});

test("complexity policies enforce approved agent and confirmation limits", () => {
  assert.deepEqual(getComplexityPolicy("LOW"), {
    mode: "LOW",
    maximumAgents: 4,
    approvalPolicy: "every-material-decision",
    requiresModelConfirmation: true,
    requiresPlanConfirmation: true,
    permitsAutonomousScheduling: false,
  });
  assert.equal(getComplexityPolicy("NORMAL").maximumAgents, 8);
  assert.equal(getComplexityPolicy("NORMAL").requiresModelConfirmation, true);
  assert.equal(getComplexityPolicy("HIGH").maximumAgents, 16);
  assert.equal(getComplexityPolicy("HIGH").requiresModelConfirmation, false);
  assert.equal(getComplexityPolicy("HIGH").permitsAutonomousScheduling, true);
});
