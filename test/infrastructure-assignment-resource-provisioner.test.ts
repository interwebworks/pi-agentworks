import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionAgent,
} from "../src/domain/controller-state.ts";
import type { AssignmentInfrastructureEvidence } from "../src/application/launch/assignment-resource-evidence.ts";
import {
  InfrastructureAssignmentResourceProvisioner,
  type AssignmentLaunchConfiguration,
} from "../src/application/launch/infrastructure-assignment-resource-provisioner.ts";
import type { RoleCatalogEntry } from "../src/application/launch/role-resource-resolver.ts";
import type { ControllerSnapshot } from "../src/application/ports/controller-repository.ts";

const role: RoleCatalogEntry = {
  id: "backend-developer",
  runtimeId: "pack/backend-developer",
  label: "Canonical API Builder",
  description: "Builds backend changes.",
  authority: "worker",
  required: false,
  taskKinds: ["software-development"],
  responsibilities: ["implement changes"],
  promptFile: "backend.md",
  tools: ["read", "write"],
  controllerActions: ["report-status"],
  writePolicy: "story-writer",
  networkAccess: "disabled",
  systemPrompt: "Build carefully.",
};

function fixture() {
  const run = createRunState({
    id: "run-1",
    title: "Ship",
    complexity: "HIGH",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktree/integration",
    createdAt: 1,
  });
  const story = createStoryState({
    id: "story-1",
    runId: run.id,
    title: "Story",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktree/story-1",
    createdAt: 1,
  });
  const agent = createAgentState({
    id: "agent-1",
    runId: run.id,
    roleRuntimeId: role.runtimeId,
    taskId: story.id,
    worktreePath: story.worktreePath,
    createdAt: 1,
  });
  const existingAgent = transitionAgent(
    createAgentState({
      id: "agent-existing",
      runId: run.id,
      roleRuntimeId: role.runtimeId,
      taskId: story.id,
      worktreePath: story.worktreePath,
      createdAt: 1,
    }),
    { type: "launch-requested", paneId: "pane-existing", at: 2 },
  );
  const snapshot: ControllerSnapshot = {
    revision: 4,
    run,
    stories: [story],
    agents: [existingAgent],
  };
  const git: AssignmentInfrastructureEvidence["git"] = {
    commonGitDirectory: "/repo/.git",
    baseBranch: run.integrationBranch,
    expectedIntegrationHead: "a".repeat(40),
    integrationBranch: run.integrationBranch,
    storyBranch: story.branchName,
    expectedStoryHead: "b".repeat(40),
    worktreePath: story.worktreePath,
  };
  const pane = {
    paneId: "pane-1",
    cwd: story.worktreePath,
    tokens: { aw_kind: "agent", aw_run: run.id, aw_agent: agent.id },
  };
  const session = {
    sessionPath: "/session",
    configPath: "/session/config",
    controllerChildAuthToken: "A".repeat(43),
  };
  const configuration: AssignmentLaunchConfiguration = {
    workspaceId: "workspace-1",
    operationId: "op-1",
    expectedTabId: "workspace-1:t1",
    expectedPaneId: pane.paneId,
    metadataSequence: 1,
    sessionId: "00000000-0000-4000-8000-000000000001",
    controllerSocketPath: "/runtime/controller.sock",
    runtimePath: "/runtime",
    controllerFenceCurrent: true,
    expectedRevisionMatches: true,
    piCliPath: "/pi/bin/pi",
    piPackagePath: "/pi",
    agentworksPackagePath: "/agentworks",
    childBridgePath: "/agentworks/bridge.ts",
    nodePath: "/usr/bin/node",
    gitMetadataPaths: ["/repo/.git"],
    additionalReadOnlyPaths: [],
    provider: "openai",
    model: "gpt-5",
    thinking: "medium",
  };
  return { run, story, agent, snapshot, git, pane, session, configuration };
}

test("resource provisioner composes Git, pane, session, and launch evidence", async () => {
  const { run, story, agent, snapshot, git, pane, session, configuration } =
    fixture();
  let rolledBack = false;
  let expectedLabels: readonly string[] = [];
  const provisioner = new InfrastructureAssignmentResourceProvisioner({
    agents: { create: () => Promise.resolve(agent) },
    git: { provisionGit: () => git },
    panes: {
      allocate: (request) => {
        expectedLabels = (request.expectedAgents ?? []).map(
          (entry) => entry.label,
        );
        return Promise.resolve(pane as never);
      },
      release: () => Promise.resolve(),
    },
    sessions: {
      create: () => Promise.resolve(session),
      cleanup: () => Promise.resolve(),
    },
    configuration: { resolve: () => Promise.resolve(configuration) },
    roles: {
      find: (runtimeId) =>
        Promise.resolve(runtimeId === role.runtimeId ? role : null),
    },
    gitRollback: {
      rollback: () => {
        rolledBack = true;
        return Promise.resolve();
      },
    },
  });

  const result = await provisioner.provision(
    "writer",
    role,
    story,
    run,
    snapshot,
  );
  assert.equal(result.agent.id, agent.id);
  assert.equal(result.paneId, pane.paneId);
  assert.equal(result.sessionId, configuration.sessionId);
  assert.deepEqual(expectedLabels, ["Canonical API Builder"]);
  assert.equal(rolledBack, false);
});

test("resource provisioner cleans session, pane, and Git workspace on evidence failure", async () => {
  const { run, story, agent, snapshot, git, pane, session, configuration } =
    fixture();
  let cleaned = false;
  let released = false;
  let rolledBack = false;
  const provisioner = new InfrastructureAssignmentResourceProvisioner({
    agents: { create: () => Promise.resolve(agent) },
    git: { provisionGit: () => git },
    panes: {
      allocate: () => Promise.resolve(pane as never),
      release: () => {
        released = true;
        return Promise.resolve();
      },
    },
    sessions: {
      create: () => Promise.resolve(session),
      cleanup: () => {
        cleaned = true;
        return Promise.resolve();
      },
    },
    configuration: {
      resolve: () =>
        Promise.resolve({ ...configuration, controllerFenceCurrent: false }),
    },
    roles: {
      find: (runtimeId) =>
        Promise.resolve(runtimeId === role.runtimeId ? role : null),
    },
    gitRollback: {
      rollback: () => {
        rolledBack = true;
        return Promise.resolve();
      },
    },
  });

  await assert.rejects(
    provisioner.provision("writer", role, story, run, snapshot),
  );
  assert.equal(cleaned, true);
  assert.equal(released, true);
  assert.equal(rolledBack, true);
});
