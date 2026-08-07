import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HerdrPane } from "../src/application/ports/herdr-gateway.ts";
import type { PiAgentLaunchRequest } from "../src/application/ports/pi-agent-launcher.ts";
import type {
  SandboxCommandPlan,
  SandboxLaunchRequest,
} from "../src/application/ports/sandbox-gateway.ts";
import {
  SecurePiAgentLaunchError,
  SecurePiAgentLauncher,
} from "../src/application/launch/secure-pi-agent-launcher.ts";
import type { RoleDefinition } from "../src/domain/role-pack.ts";
import type { TaskSpecification } from "../src/domain/task-specification.ts";

class FakeSandbox {
  readonly requests: SandboxLaunchRequest[] = [];

  plan(request: SandboxLaunchRequest): SandboxCommandPlan {
    this.requests.push(request);
    return {
      adapter: "bubblewrap",
      executablePath: "/usr/bin/bwrap",
      arguments: ["--probe-plan", request.command, ...request.arguments],
      hostEnvironment: { PATH: "/usr/bin:/bin" },
      evidence: {
        kind: "bubblewrap",
        filesystemBoundary: "kernel-enforced",
        rootReadOnly: true,
        assignedWorktreeWritable: request.worktreeAccess === "read-write",
        gitMetadataReadOnly: true,
        environmentSanitized: true,
        networkIsolated: request.networkPolicy === "isolated",
      },
    };
  }
}

class FakeHerdrLaunch {
  pane: HerdrPane;
  readonly commands: readonly string[][] = [];
  processPolls = 0;
  processAppears = true;
  processArgv: readonly string[] = [];

  constructor(worktree: string) {
    this.pane = {
      paneId: "w1P:pA",
      terminalId: "term-a",
      workspaceId: "w1P",
      tabId: "w1P:tA",
      focused: false,
      agentStatus: "unknown",
      revision: 0,
      agent: null,
      agentSession: null,
      cwd: worktree,
      foregroundCwd: worktree,
      label: "Builder",
      title: null,
      terminalTitle: null,
      terminalTitleStripped: null,
      displayAgent: "Builder",
      stateLabels: {},
      tokens: { aw_kind: "agent", aw_run: "run-1", aw_agent: "agent-1" },
    };
  }

  getPane(): Promise<HerdrPane> {
    return Promise.resolve(this.pane);
  }

  runCommand(_paneId: string, command: readonly string[]): Promise<void> {
    (this.commands as string[][]).push([...command]);
    return Promise.resolve();
  }

  getPaneProcessInfo() {
    this.processPolls += 1;
    const command =
      this.processArgv.length > 0 ? this.processArgv : (this.commands[0] ?? []);
    return Promise.resolve({
      paneId: "w1P:pA",
      shellPid: 100,
      foregroundProcessGroupId: 200,
      tty: "/dev/pts/1",
      foregroundProcesses:
        this.processAppears && this.processPolls > 1
          ? [
              {
                pid: 201,
                name: "node",
                argv: command,
                argv0: command[0] ?? null,
                cmdline: command.join(" "),
                cwd: this.pane.cwd,
              },
            ]
          : [],
    });
  }
}

function task(worktree: string, repository: string): TaskSpecification {
  return {
    schemaVersion: 1,
    runId: "run-1",
    storyId: "story-1",
    taskId: "task-1",
    title: "Implement the bounded feature",
    userStory: "As a user, I need the bounded feature.",
    objective: "Implement and validate the feature.",
    assignedAgentId: "agent-1",
    assignedRole: "builder",
    repositoryRoot: repository,
    baseBranch: "main",
    branchName: "agentworks/run-1/story/story-1",
    worktreePath: worktree,
    scope: { included: ["src/**"], excluded: ["secrets/**"] },
    technologyChoices: ["TypeScript"],
    constraints: ["Controller-only Git mutation"],
    dependencies: [],
    deliverables: ["Implementation", "Tests"],
    acceptanceCriteria: ["Tests pass"],
    validation: [{ command: "npm test", expected: "exit zero" }],
    escalationConditions: ["Missing requirement"],
    allowedTools: ["read", "edit", "write", "bash"],
    writePolicy: "story-writer",
  };
}

function role(): RoleDefinition {
  return {
    id: "builder",
    label: "Builder",
    description: "Implements one bounded story.",
    authority: "worker",
    required: true,
    taskKinds: ["software-development"],
    responsibilities: ["Implement", "Validate"],
    promptFile: "builder.md",
    tools: ["read", "edit", "write", "bash"],
    controllerActions: ["report-status", "submit-work"],
    writePolicy: "story-writer",
    networkAccess: "required",
    defaultModel: "gpt-5.6-sol",
    defaultThinking: "high",
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentworks-pi-launch-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  const session = join(root, "session");
  const runtime = join(root, "runtime");
  const piPackage = join(root, "pi-package");
  const agentworksPackage = join(root, "agentworks-package");
  for (const path of [
    repository,
    worktree,
    session,
    runtime,
    piPackage,
    agentworksPackage,
  ]) {
    mkdirSync(path, {
      mode: path === session || path === runtime ? 0o700 : 0o755,
    });
  }
  const gitMarker = join(worktree, ".git");
  const controllerSocket = join(runtime, "controller.sock");
  const piCli = join(piPackage, "cli.js");
  const childBridge = join(agentworksPackage, "child-bridge.ts");
  const nodePath = join(root, "node");
  writeFileSync(gitMarker, "gitdir: /common/git\n");
  writeFileSync(controllerSocket, "socket-placeholder");
  writeFileSync(piCli, "export {};\n");
  writeFileSync(childBridge, "export default () => {};\n");
  writeFileSync(nodePath, "#!/bin/sh\n");
  chmodSync(nodePath, 0o755);
  const sandbox = new FakeSandbox();
  const herdr = new FakeHerdrLaunch(worktree);
  const sleeps: number[] = [];
  const request: PiAgentLaunchRequest = {
    complexity: "NORMAL",
    paneId: "w1P:pA",
    task: task(worktree, repository),
    role: role(),
    rolePrompt:
      "Implement only your assigned story and report structured progress.",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "high",
    sessionId: "12345678-1234-4123-8123-123456789abc",
    sessionPath: session,
    configPath: join(session, "pi-config"),
    runtimePath: runtime,
    controllerSocketPath: controllerSocket,
    controllerChildAuthToken: "a".repeat(43),
    piCliPath: piCli,
    piPackagePath: piPackage,
    agentworksPackagePath: agentworksPackage,
    childBridgePath: childBridge,
    nodePath,
    gitMetadataPaths: [gitMarker],
    additionalReadOnlyPaths: [],
    writerLeaseActive: true,
    controllerFenceCurrent: true,
    expectedRevisionMatches: true,
  };
  herdr.processArgv = [
    nodePath,
    piCli,
    "--session-id",
    request.sessionId,
    `@${join(session, "task-assignment.md")}`,
  ];
  return {
    root,
    request,
    sandbox,
    herdr,
    sleeps,
    launcher: new SecurePiAgentLauncher(sandbox, herdr, {
      processPollAttempts: 3,
      processPollIntervalMs: 5,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    }),
  };
}

test("composes one fenced interactive Pi process through Bubblewrap and Herdr", async () => {
  const current = fixture();
  try {
    const evidence = await current.launcher.launch(current.request);
    assert.equal(evidence.paneId, "w1P:pA");
    assert.deepEqual(evidence.processIds, [201]);
    assert.match(evidence.rolePromptSha256, /^[a-f0-9]{64}$/u);
    assert.match(evidence.commandSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(current.sleeps, []);
    assert.equal(current.sandbox.requests.length, 1);
    const sandbox = current.sandbox.requests[0];
    assert.ok(sandbox);
    assert.equal(sandbox.worktreeAccess, "read-write");
    assert.equal(sandbox.networkPolicy, "host");
    assert.equal(sandbox.environment.AGENTWORKS_CHILD_MODE, "1");
    assert.equal(sandbox.environment.PI_TELEMETRY, "0");
    assert.equal(
      sandbox.environment.AGENTWORKS_CONTROLLER_TOKEN_FILE,
      evidence.controllerCapabilityPath,
    );
    assert.equal(sandbox.environment.OPENAI_API_KEY, undefined);
    assert.deepEqual(current.herdr.commands[0]?.slice(0, 1), ["/bin/sh"]);
    assert.equal(sandbox.readOnlyPaths.includes(evidence.rolePromptPath), true);
    assert.equal(sandbox.readOnlyPaths.includes(evidence.taskPromptPath), true);
    assert.equal(
      sandbox.readOnlyPaths.includes(evidence.controllerCapabilityPath),
      true,
    );

    const cli = sandbox.arguments;
    assert.equal(cli[0], current.request.piCliPath);
    assert.equal(cli.includes("--no-extensions"), true);
    assert.equal(cli.includes("--no-skills"), true);
    assert.equal(cli.includes("--no-prompt-templates"), true);
    assert.equal(cli.includes("--no-themes"), true);
    assert.equal(cli.includes("--no-approve"), true);
    assert.equal(cli.includes(current.request.childBridgePath), true);
    assert.equal(cli.includes(current.request.sessionId), true);
    assert.equal(cli.includes(`@${evidence.taskPromptPath}`), true);
    assert.equal(cli.includes(current.request.rolePrompt), false);
    assert.equal(
      JSON.stringify(current.herdr.commands).includes(
        "Controller-only Git mutation",
      ),
      false,
    );
    assert.equal(
      JSON.stringify(current.herdr.commands).includes(
        current.request.controllerChildAuthToken,
      ),
      false,
    );

    assert.equal(statSync(evidence.rolePromptPath).mode & 0o777, 0o600);
    assert.equal(statSync(evidence.taskPromptPath).mode & 0o777, 0o600);
    assert.equal(
      statSync(evidence.controllerCapabilityPath).mode & 0o777,
      0o600,
    );
    assert.match(
      readFileSync(evidence.rolePromptPath, "utf8"),
      /sole Git mutator/u,
    );
    assert.match(
      readFileSync(evidence.taskPromptPath, "utf8"),
      /"storyId": "story-1"/u,
    );
    assert.equal(
      existsSync(join(current.request.sessionPath, "pi-config")),
      true,
    );
    assert.equal(
      existsSync(join(current.request.sessionPath, "pi-sessions")),
      true,
    );
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("read-only roles receive a read-only worktree without a writer lease", async () => {
  const current = fixture();
  try {
    current.request = {
      ...current.request,
      task: {
        ...current.request.task,
        assignedRole: "reviewer",
        allowedTools: ["read"],
        writePolicy: "read-only",
      },
      role: {
        ...current.request.role,
        id: "reviewer",
        label: "Reviewer",
        authority: "reviewer",
        tools: ["read"],
        controllerActions: ["report-status", "submit-review"],
        writePolicy: "read-only",
        networkAccess: "disabled",
      },
      writerLeaseActive: false,
    };
    await current.launcher.launch(current.request);
    const sandboxRequest = current.sandbox.requests[0];
    assert.ok(sandboxRequest);
    assert.equal(sandboxRequest.worktreeAccess, "read-only");
    assert.equal(sandboxRequest.networkPolicy, "isolated");
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("launch refuses stale authority, pane mismatch, tool widening, and missing process evidence", async () => {
  const stale = fixture();
  try {
    await assert.rejects(
      stale.launcher.launch({ ...stale.request, writerLeaseActive: false }),
      /active durable writer lease/u,
    );
    await assert.rejects(
      stale.launcher.launch({
        ...stale.request,
        controllerFenceCurrent: false,
      }),
      /fence and run revision/u,
    );
    stale.herdr.pane = {
      ...stale.herdr.pane,
      tokens: { ...stale.herdr.pane.tokens, aw_agent: "other-agent" },
    };
    await assert.rejects(
      stale.launcher.launch(stale.request),
      /pane ownership/u,
    );
  } finally {
    rmSync(stale.root, { recursive: true, force: true });
  }

  const widened = fixture();
  try {
    await assert.rejects(
      widened.launcher.launch({
        ...widened.request,
        task: { ...widened.request.task, allowedTools: ["read", "delete-all"] },
      }),
      /exceed the selected role tool authority/u,
    );
  } finally {
    rmSync(widened.root, { recursive: true, force: true });
  }

  const missing = fixture();
  try {
    missing.herdr.processAppears = false;
    await assert.rejects(
      missing.launcher.launch(missing.request),
      SecurePiAgentLaunchError,
    );
    assert.equal(missing.herdr.processPolls, 4);
    assert.deepEqual(missing.sleeps, [5, 5]);
  } finally {
    rmSync(missing.root, { recursive: true, force: true });
  }
});

test("relaunch after a kill point reuses the private artifacts idempotently", async () => {
  const current = fixture();
  try {
    const first = await current.launcher.launch(current.request);
    // Simulates a crash after artifacts were written but before the agent was
    // confirmed: the artifacts already exist on the retry and must be reused.
    const second = await current.launcher.launch(current.request);
    assert.equal(current.herdr.commands.length, 1);
    assert.deepEqual(second.processIds, first.processIds);
    assert.equal(second.rolePromptPath, first.rolePromptPath);
    assert.equal(second.taskPromptPath, first.taskPromptPath);
    assert.equal(
      second.controllerCapabilityPath,
      first.controllerCapabilityPath,
    );
    assert.equal(second.rolePromptSha256, first.rolePromptSha256);
    assert.equal(second.taskPromptSha256, first.taskPromptSha256);
    assert.equal(second.commandSha256, first.commandSha256);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("reconciliation refuses conflicting Pi session evidence without sending another command", async () => {
  const current = fixture();
  try {
    await current.launcher.launch(current.request);
    current.herdr.processArgv = [
      current.request.nodePath,
      current.request.piCliPath,
      "--session-id",
      "00000000-0000-4000-8000-000000000099",
      `@${join(current.request.sessionPath, "task-assignment.md")}`,
    ];
    await assert.rejects(
      current.launcher.launch(current.request),
      /conflicting or duplicate interactive Pi process evidence/u,
    );
    assert.equal(current.herdr.commands.length, 1);
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});

test("relaunch fails closed when a private artifact was altered after a kill point", async () => {
  const current = fixture();
  try {
    const first = await current.launcher.launch(current.request);
    writeFileSync(first.rolePromptPath, "tampered role prompt\n");
    await assert.rejects(current.launcher.launch(current.request), (error) => {
      assert.ok(error instanceof SecurePiAgentLaunchError);
      assert.match(error.message, /different launch content/u);
      return true;
    });
  } finally {
    rmSync(current.root, { recursive: true, force: true });
  }
});
