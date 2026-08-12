import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBlocked,
  heartbeat,
  sessionStarted,
  type AgentMessage,
} from "../src/domain/agent-communication.ts";
import {
  applyAgentMessage,
  InvalidAgentMessageStateError,
} from "../src/domain/agent-message-state.ts";
import { createAgentState } from "../src/domain/controller-state.ts";

function agent() {
  return createAgentState({
    id: "agent-1",
    runId: "run-1",
    roleRuntimeId: "software-development/backend-developer",
    taskId: "task-1",
    worktreePath: "/worktree",
    createdAt: 1,
  });
}

function activeAgent() {
  return {
    ...agent(),
    status: "idle" as const,
    paneId: "pane-1",
    updatedAt: 2,
  };
}

function launchingAgent() {
  return {
    ...agent(),
    status: "launching" as const,
    paneId: "pane-1",
    updatedAt: 2,
  };
}

test("session-started with a path completes session readiness", () => {
  const result = applyAgentMessage(
    launchingAgent(),
    sessionStarted("run-1", "agent-1", "session-1", "/sessions/agent-1.jsonl"),
    3,
  );
  assert.equal(result.changed, true);
  assert.equal(result.agent.status, "idle");
  assert.equal(result.agent.piSessionPath, "/sessions/agent-1.jsonl");
});

test("heartbeats and progress preserve liveness without changing operation state", () => {
  const working = {
    ...activeAgent(),
    status: "working" as const,
    currentOperation: "task-1",
  };
  const progress: AgentMessage = {
    protocolVersion: 1,
    type: "operation-progress",
    runId: "run-1",
    agentId: "agent-1",
    taskId: "task-1",
    output: "still working",
  };
  const result = applyAgentMessage(working, progress, 3);
  assert.equal(result.changed, true);
  assert.equal(result.agent.status, "working");
  assert.equal(result.agent.lastHeartbeatAt, 3);
});

test("blocked messages preserve the controller's exact blocker detail", () => {
  const idle = { ...agent(), status: "idle" as const, updatedAt: 2 };
  const result = applyAgentMessage(
    idle,
    agentBlocked("run-1", "agent-1", "blocked", "needs approval"),
    3,
  );
  assert.equal(result.agent.status, "blocked");
  assert.equal(result.agent.blockedReason, "needs approval");
});

test("duplicate blocked reports remain idempotent", () => {
  const blocked = applyAgentMessage(
    { ...agent(), status: "idle" as const, updatedAt: 2 },
    agentBlocked("run-1", "agent-1", "blocked", "missing dependencies"),
    3,
  ).agent;
  const repeated = applyAgentMessage(
    blocked,
    agentBlocked("run-1", "agent-1", "blocked", "missing dependencies"),
    4,
  );
  assert.equal(repeated.changed, false);
  assert.equal(repeated.agent, blocked);
});

test("controller-directed messages cannot mutate child state", () => {
  const message = {
    protocolVersion: 1 as const,
    type: "supervisor-nudge" as const,
    runId: "run-1",
    agentId: "agent-1",
    reason: "idle" as const,
  };
  assert.throws(
    () => applyAgentMessage(agent(), message, 3),
    InvalidAgentMessageStateError,
  );
});

test("identity drift is rejected before state transition", () => {
  assert.throws(
    () => applyAgentMessage(agent(), heartbeat("run-1", "other-agent", 10), 3),
    /identity does not match/u,
  );
});
