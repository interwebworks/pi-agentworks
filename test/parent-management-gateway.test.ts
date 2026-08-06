import assert from "node:assert/strict";
import test from "node:test";
import { ControllerParentManagementGateway } from "../src/infrastructure/controller/parent-management-gateway.ts";
import {
  createAgentState,
  createRunState,
  type AgentState,
} from "../src/domain/controller-state.ts";
import type {
  ControllerSnapshot,
  JsonValue,
} from "../src/application/ports/controller-repository.ts";
import type { ParentControllerClient } from "../src/infrastructure/controller/parent-management-gateway.ts";

function snapshot(): ControllerSnapshot {
  const run = createRunState({
    id: "run-1",
    title: "Run",
    complexity: "NORMAL",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktree/integration",
    createdAt: 1,
  });
  const agent: AgentState = createAgentState({
    id: "agent-1",
    runId: "run-1",
    roleRuntimeId: "software-development/backend-developer",
    taskId: "task-1",
    worktreePath: "/worktree",
    createdAt: 1,
  });
  return { revision: 2, run, stories: [], agents: [agent] };
}

class FakeClient implements ParentControllerClient {
  readonly requests: string[] = [];
  closed = false;

  request(input: { action: string }): Promise<JsonValue> {
    this.requests.push(input.action);
    if (input.action === "snapshot.get")
      return Promise.resolve(snapshot() as unknown as JsonValue);
    return Promise.resolve([
      {
        eventId: "event-1",
        runId: "run-1",
        revision: 2,
        eventIndex: 0,
        type: "supervisor-attention-required",
        entityType: "agent",
        entityId: "agent-1",
        payload: { reason: "needs approval" },
        occurredAt: 2,
      },
    ]);
  }

  close(): void {
    this.closed = true;
  }
}

test("status reads the controller snapshot and events into dashboard data", async () => {
  const client = new FakeClient();
  const gateway = new ControllerParentManagementGateway(() => client);
  const result = await gateway.execute({ action: "status", runId: "run-1" });
  const view = JSON.parse(result.text) as {
    supervisorAttention: readonly { agentId: string; reason: string }[];
  };
  assert.deepEqual(client.requests, ["snapshot.get", "events.read"]);
  assert.equal(client.closed, true);
  assert.deepEqual(view.supervisorAttention, [
    {
      agentId: "agent-1",
      reason: "needs approval",
      eventId: "event-1",
      occurredAt: 2,
    },
  ]);
});

test("unsupported parent actions remain explicitly gated", async () => {
  const result = await new ControllerParentManagementGateway(
    () => new FakeClient(),
  ).execute({
    action: "pause",
    runId: "run-1",
  });
  assert.equal(result.notificationType, "warning");
  assert.match(result.text, /not yet wired/u);
});
