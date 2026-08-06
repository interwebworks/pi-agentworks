import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidAgentworksToolInputError,
  parseAgentworksCommand,
  parseAgentworksToolInput,
} from "../src/extension/parent-command.ts";

test("parseAgentworksCommand: no args yields null mode and empty task", () => {
  assert.deepEqual(parseAgentworksCommand(""), { mode: null, task: "" });
  assert.deepEqual(parseAgentworksCommand("   "), { mode: null, task: "" });
});

test("parseAgentworksCommand: mode plus task", () => {
  assert.deepEqual(parseAgentworksCommand("NORMAL build the thing"), {
    mode: "NORMAL",
    task: "build the thing",
  });
});

test("parseAgentworksCommand: task only, no mode token", () => {
  assert.deepEqual(parseAgentworksCommand("build the thing"), {
    mode: null,
    task: "build the thing",
  });
});

test("parseAgentworksCommand: lowercase mode is recognized", () => {
  assert.deepEqual(parseAgentworksCommand("low fix the bug"), {
    mode: "LOW",
    task: "fix the bug",
  });
});

test("parseAgentworksCommand: mode token alone with no remaining task", () => {
  assert.deepEqual(parseAgentworksCommand("HIGH"), {
    mode: "HIGH",
    task: "",
  });
});

test("parseAgentworksCommand: a bad-mode-looking first word is treated as task text", () => {
  assert.deepEqual(parseAgentworksCommand("MEDIUM build the thing"), {
    mode: null,
    task: "MEDIUM build the thing",
  });
});

test("parseAgentworksCommand: status optionally accepts a run id", () => {
  assert.deepEqual(parseAgentworksCommand("status run-123"), {
    action: "status",
    mode: null,
    task: "",
    runId: "run-123",
  });
  assert.deepEqual(parseAgentworksCommand("STATUS"), {
    action: "status",
    mode: null,
    task: "",
  });
});

test("parseAgentworksToolInput: valid action with no optional fields", () => {
  const input = parseAgentworksToolInput({ action: "status" });
  assert.equal(input.action, "status");
});

test("parseAgentworksToolInput: valid action with optional fields", () => {
  const input = parseAgentworksToolInput({
    action: "launch",
    mode: "HIGH",
    task: "build the thing",
  });
  assert.equal(input.action, "launch");
  assert.equal(input.mode, "HIGH");
  assert.equal(input.task, "build the thing");
});

test("parseAgentworksToolInput: every declared action validates", () => {
  for (const action of [
    "launch",
    "status",
    "approve",
    "reject",
    "steer",
    "pause",
    "resume",
    "focus",
    "close",
  ]) {
    const input = parseAgentworksToolInput({ action });
    assert.equal(input.action, action);
  }
});

test("parseAgentworksToolInput: missing action throws", () => {
  assert.throws(
    () => parseAgentworksToolInput({}),
    InvalidAgentworksToolInputError,
  );
});

test("parseAgentworksToolInput: unknown action throws", () => {
  assert.throws(
    () => parseAgentworksToolInput({ action: "delete-everything" }),
    InvalidAgentworksToolInputError,
  );
});

test("parseAgentworksToolInput: bad shape throws", () => {
  assert.throws(
    () => parseAgentworksToolInput("launch"),
    InvalidAgentworksToolInputError,
  );
  assert.throws(
    () => parseAgentworksToolInput(null),
    InvalidAgentworksToolInputError,
  );
  assert.throws(
    () => parseAgentworksToolInput({ action: "launch", extra: "nope" }),
    InvalidAgentworksToolInputError,
  );
});
