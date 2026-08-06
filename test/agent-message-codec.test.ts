import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBlocked,
  heartbeat,
  sessionShutdown,
  sessionStarted,
  type AgentMessage,
} from "../src/domain/agent-communication.ts";
import {
  decodeAgentMessage,
  encodeAgentMessage,
  frameAgentMessage,
  InvalidAgentMessageError,
  readAgentMessageFrames,
} from "../src/domain/agent-message-codec.ts";

const operationStarted: AgentMessage = Object.freeze({
  protocolVersion: 1,
  type: "operation-started",
  runId: "run-1",
  agentId: "agent-1",
  taskId: "task-1",
});

const operationProgress: AgentMessage = Object.freeze({
  protocolVersion: 1,
  type: "operation-progress",
  runId: "run-1",
  agentId: "agent-1",
  taskId: "task-1",
  output: "working on it",
});

const operationCompleted: AgentMessage = Object.freeze({
  protocolVersion: 1,
  type: "operation-completed",
  runId: "run-1",
  agentId: "agent-1",
  taskId: "task-1",
  success: true,
  revision: 3,
});

const supervisorNudge: AgentMessage = Object.freeze({
  protocolVersion: 1,
  type: "supervisor-nudge",
  runId: "run-1",
  agentId: "agent-1",
  reason: "idle",
});

const supervisorCompletion: AgentMessage = Object.freeze({
  protocolVersion: 1,
  type: "supervisor-completion",
  runId: "run-1",
  agentId: "agent-1",
  outcome: "success",
  revision: 2,
});

const supervisorError: AgentMessage = Object.freeze({
  protocolVersion: 1,
  type: "supervisor-error",
  runId: "run-1",
  agentId: "agent-1",
  code: "E_TIMEOUT",
  message: "agent stopped responding",
});

const samplesByCategory: Record<string, AgentMessage> = {
  lifecycle: sessionStarted("run-1", "agent-1", "session-1"),
  operation: operationStarted,
  heartbeat: heartbeat("run-1", "agent-1", 1500, 4),
  blocker: agentBlocked(
    "run-1",
    "agent-1",
    "blocked",
    "waiting on human input",
  ),
  supervisor: supervisorNudge,
};

test("round-trips one message from each category", () => {
  for (const [category, message] of Object.entries(samplesByCategory)) {
    const encoded = encodeAgentMessage(message);
    const decoded = decodeAgentMessage(encoded);
    assert.deepEqual(decoded, message, `category: ${category}`);
  }
});

test("round-trips the remaining operation and supervisor variants", () => {
  for (const message of [
    operationProgress,
    operationCompleted,
    supervisorCompletion,
    supervisorError,
    sessionShutdown("run-1", "agent-1", "session-1"),
  ]) {
    assert.deepEqual(decodeAgentMessage(encodeAgentMessage(message)), message);
  }
});

test("rejects malformed JSON", () => {
  assert.throws(
    () => decodeAgentMessage("{not json"),
    InvalidAgentMessageError,
  );
});

test("rejects an unknown type discriminant", () => {
  const text = JSON.stringify({
    protocolVersion: 1,
    type: "not-a-real-type",
    runId: "run-1",
    agentId: "agent-1",
  });
  assert.throws(() => decodeAgentMessage(text), InvalidAgentMessageError);
});

test("rejects a wrong protocolVersion", () => {
  const text = JSON.stringify({
    protocolVersion: 2,
    type: "heartbeat",
    runId: "run-1",
    agentId: "agent-1",
    elapsedMs: 10,
    revision: null,
  });
  assert.throws(() => decodeAgentMessage(text), InvalidAgentMessageError);
});

test("rejects an unexpected extra property", () => {
  const text = JSON.stringify({
    protocolVersion: 1,
    type: "heartbeat",
    runId: "run-1",
    agentId: "agent-1",
    elapsedMs: 10,
    revision: null,
    extra: "nope",
  });
  assert.throws(() => decodeAgentMessage(text), InvalidAgentMessageError);
});

test("rejects an invalid message at encode time", () => {
  const invalid = {
    protocolVersion: 1,
    type: "heartbeat",
    runId: "run-1",
    agentId: "agent-1",
    elapsedMs: -1,
    revision: null,
  } as AgentMessage;
  assert.throws(() => encodeAgentMessage(invalid), InvalidAgentMessageError);
});

test("rejects an oversize payload", () => {
  const text = JSON.stringify({
    protocolVersion: 1,
    type: "agent-blocked",
    runId: "run-1",
    agentId: "agent-1",
    reason: "blocked",
    detail: "x".repeat(70 * 1024),
  });
  assert.throws(() => decodeAgentMessage(text), InvalidAgentMessageError);
});

test("encodes newlines in field values as escaped sequences, never raw", () => {
  const message = agentBlocked(
    "run-1",
    "agent-1",
    "blocked",
    "line one\nline two",
  );
  const encoded = encodeAgentMessage(message);
  assert.ok(!encoded.includes("\n"));
  assert.deepEqual(decodeAgentMessage(encoded), message);
});

test("frames two-and-a-half messages, decoding two and returning the rest", () => {
  const first = frameAgentMessage(
    sessionStarted("run-1", "agent-1", "session-1"),
  );
  const second = frameAgentMessage(heartbeat("run-1", "agent-1", 200, null));
  const partial = encodeAgentMessage(supervisorNudge).slice(0, 10);
  const buffer = first + second + partial;

  const { messages, rest } = readAgentMessageFrames(buffer);

  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages[0],
    sessionStarted("run-1", "agent-1", "session-1"),
  );
  assert.deepEqual(messages[1], heartbeat("run-1", "agent-1", 200, null));
  assert.equal(rest, partial);
});

test("rejects an oversized unterminated frame", () => {
  assert.throws(
    () => readAgentMessageFrames("x".repeat(65 * 1024)),
    InvalidAgentMessageError,
  );
});
