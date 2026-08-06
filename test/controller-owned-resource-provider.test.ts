import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import type { WriterLease } from "../src/application/ports/controller-repository.ts";
import type { AssignmentLaunchResources } from "../src/application/launch/assignment-preparation.ts";
import {
  ControllerOwnedAssignmentResourceProvider,
  type AssignmentPrivilegedResourceProvisioner,
} from "../src/application/launch/controller-owned-resource-provider.ts";
import type { RoleCatalogEntry } from "../src/application/launch/role-resource-resolver.ts";
import type { ControllerSnapshot } from "../src/application/ports/controller-repository.ts";

const role: RoleCatalogEntry = {
  id: "backend-developer",
  runtimeId: "software-development/backend-developer",
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
  systemPrompt: "Build carefully.",
};

function fixture(): {
  readonly snapshot: ControllerSnapshot;
  readonly story: ControllerSnapshot["stories"][number];
  readonly run: ControllerSnapshot["run"];
  readonly resources: AssignmentLaunchResources;
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
  const resources: AssignmentLaunchResources = {
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
    writerLeaseActive: false,
    controllerFenceCurrent: true,
    expectedRevisionMatches: true,
  };
  return {
    snapshot: { revision: 1, run, stories: [story], agents: [agent] },
    story,
    run,
    resources,
  };
}

function lease(): WriterLease {
  return {
    runId: "run-1",
    storyId: "story-1",
    ownerAgentId: "agent-1",
    leaseToken: 7,
    expiresAt: 2_000,
    updatedAt: 1_000,
  };
}

test("resource provider acquires writer lease around complete provisioning", async () => {
  const { snapshot, story, run, resources } = fixture();
  let acquired = false;
  let rolledBack = false;
  const provisioner: AssignmentPrivilegedResourceProvisioner = {
    provision: () => Promise.resolve(resources),
    rollback: () => {
      rolledBack = true;
      return Promise.resolve();
    },
  };
  const provider = new ControllerOwnedAssignmentResourceProvider({
    repository: {
      acquireWriterLease: () => {
        acquired = true;
        return lease();
      },
      releaseWriterLease: () => {
        throw new Error("should not release on success");
      },
    },
    write: { ownerId: "controller", fencingToken: 1, now: 1_000 },
    writerLeaseTtlMs: 500,
    provisioner,
  });

  const result = await provider.resolve("writer", role, story, run, snapshot);

  assert.equal(acquired, true);
  assert.equal(result.writerLeaseActive, true);
  assert.equal(rolledBack, false);
});

test("resource provider rolls back when fence evidence is stale", async () => {
  const { snapshot, story, run, resources } = fixture();
  let rolledBack = false;
  const provisioner: AssignmentPrivilegedResourceProvisioner = {
    provision: () =>
      Promise.resolve({ ...resources, controllerFenceCurrent: false }),
    rollback: () => {
      rolledBack = true;
      return Promise.resolve();
    },
  };
  const provider = new ControllerOwnedAssignmentResourceProvider({
    repository: {
      acquireWriterLease: () => lease(),
      releaseWriterLease: () => lease(),
    },
    write: { ownerId: "controller", fencingToken: 1, now: 1_000 },
    writerLeaseTtlMs: 500,
    provisioner,
  });

  await assert.rejects(provider.resolve("writer", role, story, run, snapshot));
  assert.equal(rolledBack, true);
});
