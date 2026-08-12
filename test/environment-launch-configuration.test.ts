import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import {
  EnvironmentLaunchConfigurationError,
  EnvironmentLaunchConfigurationResolver,
} from "../src/application/launch/environment-launch-configuration.ts";
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
  return {
    run,
    story,
    snapshot: {
      revision: 3,
      run,
      stories: [story],
      agents: [],
    } as ControllerSnapshot,
  };
}

test("environment launch resolver returns deterministic runtime settings", async () => {
  const { run, story, snapshot } = fixture();
  const resolver = new EnvironmentLaunchConfigurationResolver({
    workspaceId: "workspace-1",
    expectedTabId: "workspace-1:t1",
    expectedPaneId: null,
    metadataSequence: 4,
    piCliPath: "/pi/bin/pi",
    piPackagePath: "/pi",
    agentworksPackagePath: "/agentworks",
    childBridgePath: "/agentworks/bridge.ts",
    nodePath: "/usr/bin/node",
    gitMetadataPaths: ["/repo/.git"],
    projectManagerGitMetadataPaths: [
      "/repo/.git",
      "/worktree/integration/.git",
    ],
    additionalReadOnlyPaths: [],
    provider: "openai",
    model: "gpt-5",
    thinking: "medium",
    endpoint: {
      resolve: () => ({
        controllerSocketPath: "/runtime/controller.sock",
        runtimePath: "/runtime",
        controllerFenceCurrent: true,
        expectedRevisionMatches: true,
      }),
    },
    operationId: (kind) => `${kind === "writer" ? "writer" : "reviewer"}-op`,
    sessionId: () => "00000000-0000-4000-8000-000000000001",
  });

  const result = await resolver.resolve(
    "writer",
    role,
    snapshot.agents[0] ?? ({} as never),
    story,
    run,
    snapshot,
  );
  assert.equal(result.operationId, "writer-op");
  assert.equal(result.controllerSocketPath, "/runtime/controller.sock");
  assert.equal(result.sessionId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(result.gitMetadataPaths, [
    "/repo/.git",
    "/worktree/story-1/.git",
  ]);

  const manager = await resolver.resolve(
    "project-manager",
    role,
    snapshot.agents[0] ?? ({} as never),
    story,
    run,
    snapshot,
  );
  assert.deepEqual(manager.gitMetadataPaths, [
    "/repo/.git",
    "/worktree/integration/.git",
  ]);
});

test("environment launch resolver rejects missing required paths", () => {
  assert.throws(
    () =>
      new EnvironmentLaunchConfigurationResolver({
        workspaceId: "",
        expectedTabId: null,
        expectedPaneId: null,
        metadataSequence: 1,
        piCliPath: "/pi/bin/pi",
        piPackagePath: "/pi",
        agentworksPackagePath: "/agentworks",
        childBridgePath: "/agentworks/bridge.ts",
        nodePath: "/usr/bin/node",
        gitMetadataPaths: [],
        additionalReadOnlyPaths: [],
        provider: "openai",
        model: "gpt-5",
        thinking: "medium",
        endpoint: {} as never,
        operationId: () => "op",
        sessionId: () => "session",
      }),
    EnvironmentLaunchConfigurationError,
  );
});
