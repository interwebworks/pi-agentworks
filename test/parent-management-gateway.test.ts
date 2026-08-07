import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { runControllerProcess } from "../src/controller/process-entry.ts";
import { discoverControllerRuntime } from "../src/infrastructure/controller/controller-runtime.ts";

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

test("status from another pane restores management beside the controller-recorded origin", async () => {
  const runtimeRoot = mkdtempSync(
    join(tmpdir(), "agentworks-management-pane-"),
  );
  const requests: unknown[] = [];
  const runtime = {
    workspaceId: "w1P",
    origin: { tabId: "w1P:t2", paneId: "w1P:p1" },
    provider: "local-sglang",
    model: "Qwen/Qwen3.5-2B",
    thinking: "off" as const,
    allowHostNetwork: true,
  };
  let runId: string | undefined;
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
      {
        managementPaneLauncher: {
          ensure(request) {
            requests.push(request);
            return Promise.resolve({
              paneId: "w1P:p2",
              paneCreated: requests.length === 1,
              dashboardStarted: requests.length === 1,
            });
          },
        },
      },
    );
    const result = await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "open the management pane",
      runtime,
    });
    runId = /Agentworks run (\S+) created/u.exec(result.text)?.[1];
    assert.ok(runId);
    assert.match(result.text, /Management pane: w1P:p2/u);
    const status = await gateway.execute({
      action: "status",
      runId,
      runtime: {
        ...runtime,
        origin: { tabId: "w1P:t9", paneId: "w1P:p9" },
      },
    });
    assert.match(status.text, /Management pane: w1P:p2/u);
    assert.deepEqual(requests, [
      {
        runId,
        runtimeRoot,
        workspaceId: "w1P",
        parentTabId: "w1P:t2",
        parentPaneId: "w1P:p1",
      },
      {
        runId,
        runtimeRoot,
        workspaceId: "w1P",
        parentTabId: "w1P:t2",
        parentPaneId: "w1P:p1",
      },
    ]);
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

test("management pane failure prevents agents and status retries bootstrap", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-pane-retry-"));
  let attempts = 0;
  const requests: unknown[] = [];
  let runId: string | undefined;
  const runtime = {
    workspaceId: "w1P",
    origin: { tabId: "w1P:t2", paneId: "w1P:p1" },
    provider: "local-sglang",
    model: "Qwen/Qwen3.5-2B",
    thinking: "off" as const,
    allowHostNetwork: true,
  };
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
      {
        managementPaneLauncher: {
          ensure(request) {
            requests.push(request);
            attempts += 1;
            if (attempts === 1) throw new Error("split interrupted");
            return Promise.resolve({
              paneId: "w1P:p2",
              paneCreated: false,
              dashboardStarted: true,
            });
          },
        },
      },
    );
    const launch = await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "retry management bootstrap",
      runtime,
    });
    runId = /Agentworks run (\S+) was saved/u.exec(launch.text)?.[1];
    assert.ok(runId);
    assert.equal(launch.notificationType, "error");
    assert.match(launch.text, /Retry with \/agentworks status/u);

    const status = await gateway.execute({
      action: "status",
      runId,
      runtime: {
        ...runtime,
        origin: { tabId: "w1P:t8", paneId: "w1P:p8" },
      },
    });
    assert.match(status.text, /Management pane: w1P:p2/u);
    assert.equal(attempts, 2);
    assert.deepEqual(
      requests.map((request) => {
        const value = request as { parentTabId: string; parentPaneId: string };
        return [value.parentTabId, value.parentPaneId];
      }),
      [
        ["w1P:t2", "w1P:p1"],
        ["w1P:t2", "w1P:p1"],
      ],
    );
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

test("status never adopts the caller origin when controller state has none", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-origin-refusal-"));
  let launcherCalls = 0;
  let runId: string | undefined;
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
      {
        managementPaneLauncher: {
          ensure() {
            launcherCalls += 1;
            return Promise.resolve({
              paneId: "w1P:p2",
              paneCreated: true,
              dashboardStarted: true,
            });
          },
        },
      },
    );
    const launch = await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "refuse mutable recovery origin",
    });
    runId = /Agentworks run (\S+) was saved/u.exec(launch.text)?.[1];
    assert.ok(runId);
    assert.equal(launch.notificationType, "error");
    assert.match(launch.text, /controller has no authoritative parent origin/u);
    assert.equal(launcherCalls, 0);

    const status = await gateway.execute({
      action: "status",
      runId,
      runtime: {
        workspaceId: "w1P",
        origin: { tabId: "w1P:t9", paneId: "w1P:p9" },
        provider: "local-sglang",
        model: "Qwen/Qwen3.5-2B",
        thinking: "off",
        allowHostNetwork: true,
      },
    });
    assert.equal(status.notificationType, "warning");
    assert.match(status.text, /controller has no authoritative parent origin/u);
    assert.equal(launcherCalls, 0);
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

test("HIGH launch resumes exactly one first tick after dashboard recovery", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-deferred-tick-"));
  const runId = "run-deferred";
  let releaseLaunch: (() => void) | undefined;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  let launchSets = 0;
  const launchSetCount = (): number => launchSets;
  const controllerProcess = runControllerProcess(
    { runtimeRoot, runId, ownerId: "deferred-controller" },
    {
      orchestrationFactory: (controllerRuntime) => ({
        async execute(write) {
          launchSets += 1;
          const snapshot = controllerRuntime.repository.loadSnapshot(runId);
          if (snapshot === null) throw new Error("run was not initialized");
          if (
            controllerRuntime.repository.materializeAgentLaunch === undefined
          ) {
            throw new Error("agent launch materialization is unavailable");
          }
          controllerRuntime.repository.materializeAgentLaunch({
            write,
            agent: createAgentState({
              id: "agent-deferred",
              runId,
              roleRuntimeId: "general-delivery/project-manager",
              taskId: null,
              worktreePath: snapshot.run.integrationWorktree,
              createdAt: write.now,
            }),
            paneId: "w1P:p-agent",
            sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          });
          await launchGate;
          return { accepted: true, actions: ["assign-project-manager"] };
        },
      }),
    },
  );
  let managementAttempts = 0;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (discoverControllerRuntime(runtimeRoot, runId) !== null) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(discoverControllerRuntime(runtimeRoot, runId));
    const runtime = {
      workspaceId: "w1P",
      origin: { tabId: "w1P:t2", paneId: "w1P:p1" },
      provider: "local-sglang",
      model: "Qwen/Qwen3.5-2B",
      thinking: "off" as const,
      allowHostNetwork: true,
    };
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
      {
        enableLiveComposition: true,
        managementPaneLauncher: {
          ensure: () => {
            managementAttempts += 1;
            if (managementAttempts === 1) {
              throw new Error("split interrupted");
            }
            return Promise.resolve({
              paneId: "w1P:p2",
              paneCreated: false,
              dashboardStarted: true,
            });
          },
        },
      },
    );

    const launched = await gateway.execute({
      action: "launch",
      mode: "HIGH",
      task: "Recover launch",
      runId,
      runtime,
    });
    assert.equal(launched.notificationType, "error");
    assert.match(launched.text, /was saved, but no agent was started/u);
    assert.equal(launchSetCount(), 0);
    const initializedClient =
      await createDiscoveredParentClientFactory(runtimeRoot)(runId);
    let initialized: ControllerSnapshot;
    try {
      initialized = (await initializedClient.request({
        action: "snapshot.get",
        payload: {},
      })) as unknown as ControllerSnapshot;
    } finally {
      initializedClient.close();
    }
    assert.equal(initialized.run.status, "ready");
    assert.equal(initialized.agents.length, 0);

    const statuses = Array.from({ length: 4 }, () =>
      gateway.execute({ action: "status", runId, runtime }),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (launchSetCount() === 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(launchSetCount(), 1);
    releaseLaunch?.();
    const results = await Promise.all(statuses);
    assert.equal(launchSetCount(), 1);
    assert.equal(
      results.some((result) =>
        result.text.includes(
          "Deferred first orchestration tick resumed with 1 agent",
        ),
      ),
      true,
    );
    assert.equal(
      results.some((result) => result.text.includes("Agents: 1")),
      true,
    );

    const repeated = await gateway.execute({
      action: "status",
      runId,
      runtime,
    });
    assert.equal(launchSetCount(), 1);
    assert.equal(repeated.text.includes("Agents: 1"), true);
    assert.equal(
      repeated.text.includes("Deferred first orchestration tick resumed"),
      false,
    );
  } finally {
    releaseLaunch?.();
    if (discoverControllerRuntime(runtimeRoot, runId) !== null) {
      const client =
        await createDiscoveredParentClientFactory(runtimeRoot)(runId);
      try {
        await client.request({ action: "controller.shutdown", payload: {} });
      } finally {
        client.close();
      }
    }
    await controllerProcess;
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("live launch explains that an unborn repository needs an initial commit", async () => {
  const repository = mkdtempSync(join(tmpdir(), "agentworks-unborn-repo-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-parent-gateway-"));
  try {
    execFileSync("git", ["init", "-b", "main", repository]);
    const result = await createDiscoveredParentManagementGateway(
      runtimeRoot,
      repository,
      {
        enableLiveComposition: true,
        managementPaneLauncher: {
          ensure: () =>
            Promise.resolve({
              paneId: "w1P:p2",
              paneCreated: true,
              dashboardStarted: true,
            }),
        },
      },
    ).execute({
      action: "launch",
      mode: "HIGH",
      task: "work in an unborn repository",
      runtime: {
        workspaceId: "w1P",
        origin: { tabId: "w1P:t1", paneId: "w1P:p1" },
        provider: "local-sglang",
        model: "Qwen/Qwen3.5-2B",
        thinking: "off",
        allowHostNetwork: true,
      },
    });
    assert.equal(result.notificationType, "error");
    assert.match(result.text, /has no Git commit/u);
    assert.match(result.text, /initial commit/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
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
