import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBlocked,
  heartbeat,
  operationCompleted,
} from "../src/domain/agent-communication.ts";
import { reactionForAgentMessage } from "../src/domain/supervisor-reaction.ts";

test("blocked child messages require supervisor attention", () => {
  assert.deepEqual(
    reactionForAgentMessage(
      agentBlocked("run-1", "agent-1", "blocked", "needs approval"),
    ),
    {
      type: "attention-required",
      runId: "run-1",
      agentId: "agent-1",
      reason: "needs approval",
    },
  );
});

test("failed operation results require supervisor attention", () => {
  assert.deepEqual(
    reactionForAgentMessage(operationCompleted("run-1", "agent-1", false)),
    {
      type: "attention-required",
      runId: "run-1",
      agentId: "agent-1",
      reason: "child operation reported failure",
    },
  );
});

test("healthy heartbeats do not create attention noise", () => {
  assert.deepEqual(reactionForAgentMessage(heartbeat("run-1", "agent-1", 10)), {
    type: "none",
  });
});
