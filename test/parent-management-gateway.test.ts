import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  ControllerParentManagementGateway,
  createDiscoveredParentClientFactory,
  createDiscoveredParentManagementGateway,
} from "../src/infrastructure/controller/parent-management-gateway.ts";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionAgent,
  type AgentState,
} from "../src/domain/controller-state.ts";
import type {
  ControllerSnapshot,
  JsonValue,
} from "../src/application/ports/controller-repository.ts";
import type { ParentControllerClient } from "../src/infrastructure/controller/parent-management-gateway.ts";
import type { ControllerClientRequest } from "../src/infrastructure/controller/unix-controller-transport.ts";
import { runControllerProcess } from "../src/controller/process-entry.ts";
import {
  discoverControllerRuntime,
  readProcessStartIdentity,
  resolveControllerRuntimePaths,
} from "../src/infrastructure/controller/controller-runtime.ts";
import { createControllerLaunchComposition } from "../src/infrastructure/controller/controller-launch-composition.ts";
import { DetachedControllerSupervisor } from "../src/infrastructure/controller/detached-controller-supervisor.ts";
import { SqliteControllerRepository } from "../src/infrastructure/controller/sqlite-controller-repository.ts";

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error("Timed out waiting for condition");
}

async function stopDiscoveredController(
  runtimeRoot: string,
  runId: string,
): Promise<void> {
  if (discoverControllerRuntime(runtimeRoot, runId) === null) return;
  const client = await createDiscoveredParentClientFactory(runtimeRoot)(runId);
  try {
    await client.request({ action: "controller.shutdown", payload: {} });
  } finally {
    client.close();
  }
  await waitFor(() => discoverControllerRuntime(runtimeRoot, runId) === null);
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
    assert.equal(launched.launchedRunId, runId);
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

test("status restarts a stopped controller only from authenticated immutable composition", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-dead-status-"));
  let runId: string | undefined;
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    );
    const launched = await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "preserve restart authority",
    });
    runId = /Agentworks run (\S+) (?:was saved|created)/u.exec(
      launched.text,
    )?.[1];
    assert.ok(runId);
    const original = discoverControllerRuntime(runtimeRoot, runId);
    assert.ok(original);
    const client =
      await createDiscoveredParentClientFactory(runtimeRoot)(runId);
    try {
      await client.request({ action: "controller.shutdown", payload: {} });
    } finally {
      client.close();
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (discoverControllerRuntime(runtimeRoot, runId) === null) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(discoverControllerRuntime(runtimeRoot, runId), null);

    const status = await gateway.execute({ action: "status", runId });
    assert.equal(status.notificationType, undefined);
    assert.match(status.text, /preserve restart authority/u);
    const restarted = discoverControllerRuntime(runtimeRoot, runId);
    assert.ok(restarted);
    assert.notEqual(
      restarted.descriptor.processId,
      original.descriptor.processId,
    );
    assert.equal(restarted.descriptor.fencingToken, 2);
  } finally {
    if (
      runId !== undefined &&
      discoverControllerRuntime(runtimeRoot, runId) !== null
    ) {
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
      launchComposition: createControllerLaunchComposition(
        runId,
        {},
        process.cwd(),
      ),
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

test("SIGKILL followed by status restarts once from exact composition without duplicate resources", async () => {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "agentworks-restart-repo-"),
  );
  const runtimeRoot = mkdtempSync(
    join(tmpdir(), "agentworks-restart-runtime-"),
  );
  const runId = "run-status-restart";
  const runtime = {
    workspaceId: "w1P",
    origin: { tabId: "w1P:t1", paneId: "w1P:p1" },
    provider: "local-sglang",
    model: "Qwen/Qwen3.5-2B",
    thinking: "off" as const,
    allowHostNetwork: true,
  };
  let dashboardStarts = 0;
  let managementEnsures = 0;
  let paneShell: ChildProcess | null = null;
  let paneShellIdentity: string | null = null;
  try {
    execFileSync("git", ["init", "-b", "main", repositoryRoot]);
    execFileSync("git", ["-C", repositoryRoot, "config", "user.name", "Test"]);
    execFileSync("git", [
      "-C",
      repositoryRoot,
      "config",
      "user.email",
      "test@example.com",
    ]);
    writeFileSync(join(repositoryRoot, "README.md"), "restart fixture\n");
    execFileSync("git", ["-C", repositoryRoot, "add", "README.md"]);
    execFileSync("git", ["-C", repositoryRoot, "commit", "-m", "fixture"]);
    const integrationWorktree = join(
      runtimeRoot,
      "worktrees",
      runId,
      "integration-worktree",
    );
    paneShell = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      {
        env: {
          PATH: process.env.PATH,
          AGENTWORKS_RUN_ID: runId,
          AGENTWORKS_PANE_KIND: "agent",
          AGENTWORKS_PANE_OPERATION_ID: runId,
          AGENTWORKS_AGENT_ID: "agent-survivor",
          AGENTWORKS_PANE_SLOT: "0",
        },
        stdio: "ignore",
      },
    );
    assert.ok(paneShell.pid);
    await waitFor(() => readProcessStartIdentity(paneShell?.pid ?? 0) !== null);
    paneShellIdentity = readProcessStartIdentity(paneShell.pid);
    assert.ok(paneShellIdentity);
    const herdrPath = join(runtimeRoot, "fake-herdr.mjs");
    const pane = {
      pane_id: "w1P:pagent",
      terminal_id: "terminal-agent",
      workspace_id: "w1P",
      tab_id: "w1P:t-agent",
      focused: false,
      agent_status: "idle",
      revision: 1,
      cwd: integrationWorktree,
      tokens: {
        aw_kind: "agent",
        aw_run: runId,
        aw_operation: runId,
        aw_agent: "agent-survivor",
        aw_slot: "0",
      },
    };
    writeFileSync(
      herdrPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("herdr 1.0.0\\n");
} else if (args[0] === "api" && args[1] === "schema") {
  process.stdout.write(JSON.stringify({ protocol: 17, schema_version: 1 }));
} else if (args[0] === "pane" && args[1] === "list") {
  process.stdout.write(JSON.stringify({ id: "fake-pane-list", result: { type: "pane_list", panes: [${JSON.stringify(pane)}] } }));
} else if (args[0] === "pane" && args[1] === "process-info") {
  process.stdout.write(JSON.stringify({ id: "fake-process-info", result: { type: "pane_process_info", process_info: { pane_id: "w1P:pagent", shell_pid: ${String(paneShell.pid)} } } }));
} else {
  process.stderr.write("unsupported fake Herdr command: " + args.join(" ") + "\\n");
  process.exitCode = 2;
}
`,
      { mode: 0o755 },
    );
    chmodSync(herdrPath, 0o755);
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      repositoryRoot,
      {
        enableLiveComposition: true,
        herdrPath,
        controllerLeaseTtlMs: 600,
        controllerRenewIntervalMs: 100,
        controllerStartupTimeoutMs: 10_000,
        controllerPollIntervalMs: 20,
        managementPaneLauncher: {
          ensure() {
            managementEnsures += 1;
            const dashboardStarted = managementEnsures === 1;
            if (dashboardStarted) dashboardStarts += 1;
            return Promise.resolve({
              paneId: "w1P:p2",
              paneCreated: dashboardStarted,
              dashboardStarted,
            });
          },
        },
      },
    );
    const launched = await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "recover one exact controller",
      runId,
      runtime,
    });
    assert.equal(launched.notificationType, undefined);
    const initialController = discoverControllerRuntime(runtimeRoot, runId);
    assert.ok(initialController);

    const drifted = await gateway.execute({
      action: "status",
      runId,
      runtime: { ...runtime, model: "Qwen/drifted" },
    });
    assert.equal(drifted.notificationType, "error");
    assert.match(drifted.text, /caller drifted.*model/u);
    assert.equal(
      discoverControllerRuntime(runtimeRoot, runId)?.descriptor.processId,
      initialController.descriptor.processId,
    );
    assert.equal(managementEnsures, 1);

    const paths = resolveControllerRuntimePaths(runtimeRoot, runId);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const piSessionDirectory = join(
      runtimeRoot,
      "sessions",
      runId,
      "surviving-agent",
      "pi-sessions",
    );
    mkdirSync(piSessionDirectory, { recursive: true, mode: 0o700 });
    const piSessionFile = join(
      piSessionDirectory,
      `2026-01-01T00-00-00_${sessionId}.jsonl`,
    );
    writeFileSync(
      piSessionFile,
      `${JSON.stringify({ type: "session", id: sessionId })}\n`,
      { mode: 0o600 },
    );
    const repository = new SqliteControllerRepository(paths.databasePath);
    const descriptor = discoverControllerRuntime(
      runtimeRoot,
      runId,
    )?.descriptor;
    assert.ok(descriptor);
    const materializeTime = Date.now();
    repository.materializeAgentLaunch({
      write: {
        ownerId: descriptor.ownerId,
        fencingToken: descriptor.fencingToken,
        now: materializeTime,
      },
      agent: createAgentState({
        id: "agent-survivor",
        runId,
        roleRuntimeId: "general-delivery/project-manager",
        taskId: null,
        worktreePath: integrationWorktree,
        createdAt: materializeTime,
      }),
      paneId: "w1P:pagent",
      sessionId,
    });
    const materialized = repository.loadSnapshot(runId);
    assert.ok(materialized);
    const launching = materialized.agents.find(
      (agent) => agent.id === "agent-survivor",
    );
    assert.ok(launching);
    const idle = transitionAgent(launching, {
      type: "session-ready",
      piSessionPath: piSessionFile,
      at: materializeTime + 1,
    });
    repository.commitSnapshot({
      write: {
        ownerId: descriptor.ownerId,
        fencingToken: descriptor.fencingToken,
        now: materializeTime + 1,
      },
      runId,
      expectedRevision: materialized.revision,
      idempotencyKey: "record-surviving-agent-session",
      request: { command: "record-surviving-agent-session" },
      run: materialized.run,
      stories: materialized.stories,
      agents: materialized.agents.map((agent) =>
        agent.id === idle.id ? idle : agent,
      ),
      events: [
        {
          eventId: "surviving-agent-session-ready",
          type: "agent-session-ready",
          entityType: "agent",
          entityId: idle.id,
          payload: { paneId: idle.paneId, sessionId },
          occurredAt: materializeTime + 1,
        },
      ],
    });
    repository.confirmAgentLaunch({
      write: {
        ownerId: descriptor.ownerId,
        fencingToken: descriptor.fencingToken,
        now: materializeTime + 2,
      },
      runId,
      agentId: idle.id,
      paneId: "w1P:pagent",
      sessionId,
      processIds: [paneShell.pid],
      commandSha256: "a".repeat(64),
    });
    repository.close();
    const first = discoverControllerRuntime(runtimeRoot, runId);
    assert.ok(first);
    process.kill(first.descriptor.processId, "SIGKILL");
    await waitFor(
      () => readProcessStartIdentity(first.descriptor.processId) === null,
    );
    const beforeExpiry = await gateway.execute({
      action: "status",
      runId,
      runtime,
    });
    assert.equal(beforeExpiry.notificationType, "error");
    assert.match(beforeExpiry.text, /stale controller lease has not expired/u);
    assert.equal(readProcessStartIdentity(first.descriptor.processId), null);

    const waitMs = Math.max(
      0,
      first.descriptor.leaseExpiresAt - Date.now() + 25,
    );
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, waitMs));
    const recovered = await gateway.execute({
      action: "status",
      runId,
      runtime,
    });
    assert.equal(
      recovered.notificationType,
      undefined,
      `${recovered.text}\n${readFileSync(join(paths.runtimeDirectory, "controller.log"), "utf8")}`,
    );
    assert.match(recovered.text, /recover one exact controller/u);
    const second = discoverControllerRuntime(runtimeRoot, runId);
    assert.ok(second);
    assert.notEqual(second.descriptor.processId, first.descriptor.processId);
    assert.equal(second.descriptor.fencingToken, 2);
    assert.equal(second.descriptor.recovery.status, "ready");

    const repeated = await gateway.execute({
      action: "status",
      runId,
      runtime,
    });
    assert.equal(repeated.notificationType, undefined);
    assert.equal(
      discoverControllerRuntime(runtimeRoot, runId)?.descriptor.processId,
      second.descriptor.processId,
    );
    assert.equal(dashboardStarts, 1);
    assert.equal(managementEnsures, 3);

    const database = new DatabaseSync(paths.databasePath, { readOnly: true });
    try {
      const counts = database
        .prepare(
          `SELECT
             (SELECT count(*) FROM runs) AS runs,
             (SELECT count(*) FROM stories) AS stories,
             (SELECT count(*) FROM agents) AS agents,
             (SELECT count(*) FROM agent_launches) AS launches,
             (SELECT count(*) FROM agent_pane_restorations) AS restorations,
             (SELECT count(*) FROM controller_launch_compositions) AS compositions`,
        )
        .get() as unknown as Record<string, number>;
      assert.deepEqual(
        { ...counts },
        {
          runs: 1,
          stories: 1,
          agents: 1,
          launches: 1,
          restorations: 0,
          compositions: 1,
        },
      );
    } finally {
      database.close();
    }
    const worktreeList = execFileSync(
      "git",
      ["-C", repositoryRoot, "worktree", "list", "--porcelain"],
      { encoding: "utf8" },
    );
    assert.equal(
      worktreeList.split("\n").filter((line) => line.startsWith("worktree "))
        .length,
      2,
    );
    const sessionRoot = join(runtimeRoot, "sessions");
    assert.equal(existsSync(sessionRoot), true);
    assert.deepEqual(readdirSync(sessionRoot), [runId]);
    assert.deepEqual(readdirSync(piSessionDirectory), [
      `2026-01-01T00-00-00_${sessionId}.jsonl`,
    ]);
    assert.equal(readProcessStartIdentity(paneShell.pid), paneShellIdentity);
    const launchEvidence = new DatabaseSync(paths.databasePath, {
      readOnly: true,
    });
    try {
      const row = launchEvidence
        .prepare(
          "SELECT process_ids_json, pane_id, session_id FROM agent_launches WHERE run_id = ? AND agent_id = ?",
        )
        .get(runId, "agent-survivor") as unknown as {
        readonly process_ids_json: string;
        readonly pane_id: string;
        readonly session_id: string;
      };
      assert.deepEqual(JSON.parse(row.process_ids_json), [paneShell.pid]);
      assert.equal(row.pane_id, "w1P:pagent");
      assert.equal(row.session_id, sessionId);
    } finally {
      launchEvidence.close();
    }
  } finally {
    await stopDiscoveredController(runtimeRoot, runId).catch(() => undefined);
    paneShell?.kill("SIGTERM");
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("status refuses a missing persisted launch composition", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-missing-comp-"));
  const runId = "run-missing-composition";
  const supervisor = new DetachedControllerSupervisor({
    runtimeRoot,
    runId,
    startupTimeoutMs: 10_000,
    pollIntervalMs: 20,
  });
  try {
    await supervisor.ensureRunning();
    const client =
      await createDiscoveredParentClientFactory(runtimeRoot)(runId);
    const now = Date.now();
    try {
      const run = createRunState({
        id: runId,
        title: "missing composition",
        complexity: "NORMAL",
        repositoryRoot: "/repo",
        originalCheckout: "/repo",
        baseBranch: "main",
        integrationBranch: `agentworks/${runId}/integration`,
        integrationWorktree: `/worktrees/${runId}/integration`,
        createdAt: now,
      });
      const story = createStoryState({
        id: `${runId}-story-1`,
        runId,
        title: "missing composition",
        branchName: `agentworks/${runId}/story-1`,
        worktreePath: `/worktrees/${runId}/story-1`,
        createdAt: now,
      });
      await client.request({
        action: "run.initialize",
        payload: {
          run,
          stories: [story],
          agents: [],
          events: [
            {
              eventId: "missing-composition-run-created",
              type: "run-created",
              entityType: "run",
              entityId: runId,
              payload: {},
              occurredAt: now,
            },
          ],
        } as unknown as JsonValue,
      });
      await client.request({ action: "controller.shutdown", payload: {} });
    } finally {
      client.close();
    }
    await waitFor(() => discoverControllerRuntime(runtimeRoot, runId) === null);
    const result = await createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    ).execute({ action: "status", runId });
    assert.equal(result.notificationType, "error");
    assert.match(result.text, /launch composition evidence is missing/u);
    assert.equal(discoverControllerRuntime(runtimeRoot, runId), null);
  } finally {
    await supervisor.stop().catch(() => undefined);
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("status refuses a live process-start identity competing for takeover", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-competing-"));
  const runId = "run-competing-controller";
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    );
    await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "reject competing controller",
      runId,
    });
    await stopDiscoveredController(runtimeRoot, runId);
    const paths = resolveControllerRuntimePaths(runtimeRoot, runId);
    const repository = new SqliteControllerRepository(paths.databasePath);
    const now = Date.now();
    const lease = repository.acquireLease("competing-owner", now, 10_000);
    repository.close();
    const descriptor = {
      schemaVersion: 1,
      runId,
      ownerId: lease.ownerId,
      processId: process.pid,
      processStartIdentity: readProcessStartIdentity(process.pid),
      startedAt: now,
      leaseExpiresAt: lease.expiresAt,
      fencingToken: lease.fencingToken,
      recovery: { status: "ready", reasons: [] },
      runtimeDirectory: paths.runtimeDirectory,
      databasePath: paths.databasePath,
      socketPath: paths.socketPath,
      tokenPath: paths.tokenPath,
    };
    writeFileSync(paths.descriptorPath, `${JSON.stringify(descriptor)}\n`, {
      mode: 0o600,
    });
    chmodSync(paths.descriptorPath, 0o600);

    const result = await gateway.execute({ action: "status", runId });
    assert.equal(result.notificationType, "error");
    assert.match(result.text, /live competing controller/u);
    assert.equal(
      readProcessStartIdentity(process.pid),
      descriptor.processStartIdentity,
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("status refuses an active orphan controller socket before restart", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-active-socket-"));
  const runId = "run-active-socket";
  const server = createServer((socket) => socket.end());
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    );
    await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "reject active socket",
      runId,
    });
    await stopDiscoveredController(runtimeRoot, runId);
    const paths = resolveControllerRuntimePaths(runtimeRoot, runId);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(paths.socketPath, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });

    const result = await gateway.execute({ action: "status", runId });
    assert.equal(result.notificationType, "error");
    assert.match(result.text, /controller socket is active/u);
    assert.equal(discoverControllerRuntime(runtimeRoot, runId), null);
  } finally {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("status refuses composition authentication failure before restart", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-auth-status-"));
  const runId = "run-auth-status";
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    );
    await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "reject unauthenticated composition",
      runId,
    });
    await stopDiscoveredController(runtimeRoot, runId);
    const paths = resolveControllerRuntimePaths(runtimeRoot, runId);
    const database = new DatabaseSync(paths.databasePath);
    try {
      database
        .prepare(
          "UPDATE controller_launch_compositions SET authentication_tag = ? WHERE run_id = ?",
        )
        .run("0".repeat(64), runId);
    } finally {
      database.close();
    }

    const result = await gateway.execute({ action: "status", runId });
    assert.equal(result.notificationType, "error");
    assert.match(result.text, /composition authentication failed/u);
    assert.equal(discoverControllerRuntime(runtimeRoot, runId), null);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("status refuses physical database corruption before restart", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-corrupt-status-"));
  const runId = "run-corrupt-status";
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    );
    await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "reject corrupt database",
      runId,
    });
    await stopDiscoveredController(runtimeRoot, runId);
    const paths = resolveControllerRuntimePaths(runtimeRoot, runId);
    writeFileSync(paths.databasePath, "not a sqlite database", { flag: "w" });

    const result = await gateway.execute({ action: "status", runId });
    assert.equal(result.notificationType, "error");
    assert.match(result.text, /not a database|database.*malformed|integrity/u);
    assert.equal(discoverControllerRuntime(runtimeRoot, runId), null);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("status refuses incomplete startup recovery evidence before restart", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "agentworks-recovery-gate-"));
  const runId = "run-incomplete-recovery";
  try {
    const gateway = createDiscoveredParentManagementGateway(
      runtimeRoot,
      process.cwd(),
    );
    await gateway.execute({
      action: "launch",
      mode: "NORMAL",
      task: "reject incomplete recovery",
      runId,
    });
    await stopDiscoveredController(runtimeRoot, runId);
    const paths = resolveControllerRuntimePaths(runtimeRoot, runId);
    const repository = new SqliteControllerRepository(paths.databasePath);
    const lease = repository.acquireLease("recovery-fixture", 10_000, 1_000);
    const current = repository.loadSnapshot(runId);
    assert.ok(current);
    let interrupted = createAgentState({
      id: "interrupted-agent",
      runId,
      roleRuntimeId: "general-delivery/project-manager",
      taskId: null,
      worktreePath: current.run.integrationWorktree,
      createdAt: 10_001,
    });
    interrupted = transitionAgent(interrupted, {
      type: "launch-requested",
      paneId: "w1P:p-agent",
      at: 10_002,
    });
    interrupted = transitionAgent(interrupted, {
      type: "session-ready",
      piSessionPath: "/sessions/interrupted.jsonl",
      at: 10_003,
    });
    interrupted = transitionAgent(interrupted, {
      type: "operation-started",
      operation: "interrupted work",
      at: 10_004,
    });
    repository.commitSnapshot({
      write: {
        ownerId: lease.ownerId,
        fencingToken: lease.fencingToken,
        now: 10_010,
      },
      runId,
      expectedRevision: current.revision,
      idempotencyKey: "inject-interrupted-agent",
      request: { command: "inject-interrupted-agent" },
      run: current.run,
      stories: current.stories,
      agents: [interrupted],
      events: [
        {
          eventId: "interrupted-agent-injected",
          type: "agent-operation-interrupted",
          entityType: "agent",
          entityId: interrupted.id,
          payload: {},
          occurredAt: 10_010,
        },
      ],
    });
    repository.releaseLease({
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      now: 10_011,
    });
    repository.close();

    const result = await gateway.execute({ action: "status", runId });
    assert.equal(result.notificationType, "error");
    assert.match(result.text, /startup recovery evidence is incomplete/u);
    assert.match(result.text, /agent-operation-interrupted/u);
    assert.equal(discoverControllerRuntime(runtimeRoot, runId), null);
  } finally {
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
