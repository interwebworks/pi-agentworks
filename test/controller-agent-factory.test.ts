import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import { ControllerAgentFactory } from "../src/application/launch/controller-agent-factory.ts";
import type { RoleCatalogEntry } from "../src/application/launch/role-resource-resolver.ts";
import type { ControllerSnapshot } from "../src/application/ports/controller-repository.ts";

const role: RoleCatalogEntry = {
  id: "backend",
  runtimeId: "pack/backend",
  label: "Backend",
  description: "Backend work.",
  authority: "worker",
  required: false,
  taskKinds: ["software-development"],
  responsibilities: ["implement"],
  promptFile: "backend.md",
  tools: ["read", "write"],
  controllerActions: ["report-status"],
  writePolicy: "story-writer",
  networkAccess: "disabled",
  systemPrompt: "Build carefully.",
};

test("controller agent factory creates identity-bound agent state", async () => {
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
  const snapshot: ControllerSnapshot = {
    revision: 1,
    run,
    stories: [story],
    agents: [],
  };
  const factory = new ControllerAgentFactory(
    () => 10,
    () => "agent-1",
  );
  const agent = await factory.create("writer", role, story, run, snapshot);
  assert.deepEqual(
    {
      id: agent.id,
      runId: agent.runId,
      roleRuntimeId: agent.roleRuntimeId,
      taskId: agent.taskId,
      worktreePath: agent.worktreePath,
      createdAt: agent.createdAt,
    },
    {
      id: "agent-1",
      runId: "run-1",
      roleRuntimeId: role.runtimeId,
      taskId: "story-1",
      worktreePath: "/worktree/story-1",
      createdAt: 10,
    },
  );
});

test("controller agent factory deterministically recovers a pre-persistence identity", async () => {
  const run = createRunState({
    id: "run-recovery",
    title: "Ship",
    complexity: "HIGH",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-recovery/integration",
    integrationWorktree: "/worktree/integration",
    createdAt: 1,
  });
  const story = createStoryState({
    id: "story-recovery",
    runId: run.id,
    title: "Story",
    branchName: "agentworks/run-recovery/story-recovery",
    worktreePath: "/worktree/story-recovery",
    createdAt: 1,
  });
  const snapshot: ControllerSnapshot = {
    revision: 1,
    run,
    stories: [story],
    agents: [],
  };
  const first = await new ControllerAgentFactory(() => 10).create(
    "writer",
    role,
    story,
    run,
    snapshot,
  );
  const recovered = await new ControllerAgentFactory(() => 20).create(
    "writer",
    role,
    story,
    run,
    snapshot,
  );

  assert.equal(recovered.id, first.id);
});
