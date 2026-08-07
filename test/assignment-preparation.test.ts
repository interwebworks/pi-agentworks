import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import {
  AssignmentPreparationError,
  DeterministicAssignmentPreparation,
  type AssignmentLaunchResources,
  type AssignmentRoleResolution,
} from "../src/application/launch/assignment-preparation.ts";
import type { RoleDefinition } from "../src/domain/role-pack.ts";
import type { ControllerSnapshot } from "../src/application/ports/controller-repository.ts";

const role: RoleDefinition = {
  id: "backend-developer",
  label: "Backend Developer",
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
};

function fixture(): {
  readonly snapshot: ControllerSnapshot;
  readonly story: ControllerSnapshot["stories"][number];
  readonly run: ControllerSnapshot["run"];
} {
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
    title: "Implement feature",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktree/story-1",
    planning: {
      narrative: "Implement feature",
      objective: "Implement feature",
      taskKinds: ["software-development"],
      writable: true,
      scope: { included: ["src"], excluded: ["secrets"] },
      technologyChoices: ["existing stack"],
      constraints: ["stay in scope"],
      dependencies: [],
      deliverables: ["feature"],
      acceptanceCriteria: ["tests pass"],
      validation: [{ command: "npm test", expected: "passes" }],
      escalationConditions: ["blocked"],
    },
    createdAt: 1,
  });
  const agent = createAgentState({
    id: "agent-1",
    runId: run.id,
    roleRuntimeId: role.id,
    taskId: story.id,
    worktreePath: story.worktreePath,
    createdAt: 1,
  });
  return {
    snapshot: { revision: 3, run, stories: [story], agents: [agent] },
    story,
    run,
  };
}

function resources(snapshot: ControllerSnapshot): AssignmentLaunchResources {
  const agent = snapshot.agents[0];
  assert.ok(agent);
  return {
    agent,
    paneId: "pane-1",
    sessionId: "00000000-0000-4000-8000-000000000001",
    sessionPath: "/session",
    configPath: "/session/config",
    runtimePath: "/runtime",
    controllerSocketPath: "/runtime/controller.sock",
    controllerChildAuthToken: "A".repeat(43),
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
    writerLeaseActive: true,
    controllerFenceCurrent: true,
    expectedRevisionMatches: true,
  };
}

test("assignment preparation builds a validated writer task and launch request", async () => {
  const { snapshot, story, run } = fixture();
  const resolved: AssignmentRoleResolution = {
    role,
    rolePrompt: "Build carefully.",
  };
  const preparation = new DeterministicAssignmentPreparation({
    resolveRole: () => Promise.resolve(resolved),
    resolveResources: () => Promise.resolve(resources(snapshot)),
  });

  const prepared = await preparation.prepareWriter(story, run, snapshot);

  assert.equal(prepared.request.task.assignedAgentId, "agent-1");
  assert.equal(prepared.request.task.assignedRole, role.id);
  assert.equal(prepared.request.task.objective, "Implement feature");
  assert.equal(prepared.request.task.writePolicy, "story-writer");
  assert.equal(prepared.request.role.id, role.id);
  assert.equal(prepared.request.expectedRevisionMatches, true);
});

test("Project Manager preparation uses the dedicated integration worktree with read-only authority", async () => {
  const { snapshot, story, run } = fixture();
  const managerRole: RoleDefinition = {
    ...role,
    id: "project-manager",
    label: "Project Manager",
    authority: "project-manager",
    tools: ["read"],
    controllerActions: ["report-status", "assign-task", "request-merge"],
    writePolicy: "read-only",
  };
  const managerAgent = createAgentState({
    id: "manager-1",
    runId: run.id,
    roleRuntimeId: "general-delivery/project-manager",
    taskId: null,
    worktreePath: run.integrationWorktree,
    createdAt: 1,
  });
  const managerResources: AssignmentLaunchResources = {
    ...resources(snapshot),
    agent: managerAgent,
    writerLeaseActive: false,
  };
  const preparation = new DeterministicAssignmentPreparation({
    resolveRole: () =>
      Promise.resolve({
        role: managerRole,
        runtimeId: "general-delivery/project-manager",
        rolePrompt: "Coordinate the team.",
      }),
    resolveResources: () => Promise.resolve(managerResources),
  });

  const prepared = await preparation.prepareProjectManager(
    story,
    run,
    snapshot,
  );

  assert.equal(prepared.request.task.storyId, "story-1-management");
  assert.equal(prepared.request.task.branchName, run.integrationBranch);
  assert.equal(prepared.request.task.worktreePath, run.integrationWorktree);
  assert.equal(prepared.request.task.writePolicy, "read-only");
  assert.equal(prepared.request.writerLeaseActive, false);
});

test("assignment preparation refuses stories without durable planning metadata", async () => {
  const { snapshot, run } = fixture();
  const story = createStoryState({
    id: "story-2",
    runId: run.id,
    title: "Missing plan",
    branchName: "agentworks/run-1/story-2",
    worktreePath: "/worktree/story-2",
    createdAt: 1,
  });
  const preparation = new DeterministicAssignmentPreparation({
    resolveRole: () => Promise.resolve({ role, rolePrompt: "Build." }),
    resolveResources: () => Promise.resolve(resources(snapshot)),
  });

  await assert.rejects(
    preparation.prepareWriter(story, run, snapshot),
    (error: unknown) =>
      error instanceof AssignmentPreparationError &&
      error.message.includes("has no durable planning metadata"),
  );
});
