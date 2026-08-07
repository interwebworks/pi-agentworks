import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ControllerParentManagementGateway,
  createDiscoveredParentClientFactory,
  createDiscoveredParentManagementGateway,
} from "../src/infrastructure/controller/parent-management-gateway.ts";
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
import type { ControllerClientRequest } from "../src/infrastructure/controller/unix-controller-transport.ts";

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
  readonly payloads: JsonValue[] = [];
  closed = false;

  request(input: ControllerClientRequest): Promise<JsonValue> {
    this.requests.push(input.action);
    this.payloads.push(input.payload);
    if (input.action === "snapshot.get")
      return Promise.resolve(snapshot() as unknown as JsonValue);
    if (input.action === "orchestration.plan") {
      return Promise.resolve({ revision: 2, actions: [] });
    }
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
  assert.deepEqual(client.requests, [
    "snapshot.get",
    "events.read",
    "orchestration.plan",
  ]);
  assert.deepEqual(client.payloads[1], {
    revision: 0,
    eventIndex: -1,
    limit: 256,
  });
  assert.equal(client.closed, true);
  assert.match(result.text, /Run \[NORMAL\] - planning/u);
  assert.match(result.text, /Stories: none/u);
  assert.match(result.text, /Next: none/u);
  assert.match(result.text, /Attention:\n\s{2}! agent-1: needs approval/u);
});

test("discovered parent launch supports a subsequent status request", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-parent-gateway-"));
  let runId: string | undefined;
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    );
    const launched = await gateway.execute({
      action: "launch",
      mode: "HIGH",
      task: "verify parent launch",
    });
    assert.equal(launched.notificationType, "error");
    assert.match(launched.text, /no agent was started/u);
    runId = /Agentworks run (\S+) was saved/u.exec(launched.text)?.[1];
    assert.ok(runId);
    const status = await gateway.execute({ action: "status", runId });
    assert.match(status.text, /HIGH/u);
  } finally {
    if (runId !== undefined) {
      const client =
        await createDiscoveredParentClientFactory(runtimeRoot)(runId);
      try {
        await client.request({ action: "controller.shutdown", payload: {} });
      } finally {
        client.close();
      }
    }
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
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
