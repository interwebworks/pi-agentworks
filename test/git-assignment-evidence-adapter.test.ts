import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import type { GitRepositoryInspection } from "../src/application/ports/git-repository-inspector.ts";
import type { GitWorkspaceResult } from "../src/application/ports/git-workspace-gateway.ts";
import {
  GitAssignmentEvidenceAdapter,
  type ExpectedIntegrationHeadResolver,
} from "../src/application/launch/git-assignment-evidence-adapter.ts";
import type { AssignmentInfrastructureEvidence } from "../src/application/launch/assignment-resource-evidence.ts";

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
  const inspection: GitRepositoryInspection = {
    requestedPath: "/repo",
    repositoryRoot: "/repo",
    gitDirectory: "/repo/.git",
    commonGitDirectory: "/repo/.git",
    bare: false,
    currentBranch: "main",
    headCommit: "a".repeat(40),
    localBranches: ["main", run.integrationBranch],
    defaultBranch: "main",
    defaultBranchSource: "conventional-local-branch",
    remotes: [],
    repositoryProtectedPatterns: [],
    objectFormat: "sha1",
  };
  return { run, story, inspection };
}

function baseEvidence(): Omit<AssignmentInfrastructureEvidence, "git"> {
  return {
    herdr: {
      paneId: "pane-1",
      cwd: "/worktree/story-1",
      tokens: { aw_kind: "agent", aw_run: "run-1", aw_agent: "agent-1" },
    },
    session: {
      sessionPath: "/session",
      configPath: "/session/config",
      controllerChildAuthToken: "A".repeat(43),
    },
    controllerSocketPath: "/runtime/controller.sock",
    runtimePath: "/runtime",
    controllerFenceCurrent: true,
    expectedRevisionMatches: true,
  };
}

test("Git evidence adapter provisions and validates the expected story workspace", () => {
  const { run, story, inspection } = fixture();
  let requestBranch = "";
  const workspace: GitWorkspaceResult = {
    status: "created",
    branch: story.branchName,
    branchHead: "b".repeat(40),
    worktreePath: story.worktreePath,
  };
  const resolver: ExpectedIntegrationHeadResolver = {
    resolve: () => "c".repeat(40),
  };
  const adapter = new GitAssignmentEvidenceAdapter({
    inspector: {
      inspect: () => inspection,
      assertBranchExists: (_inspection, branch) => {
        requestBranch = branch;
      },
    },
    git: {
      listWorktrees: () => [],
      createIntegrationWorkspace: () => workspace,
      createStoryWorkspace: (request) => {
        assert.equal(request.expectedIntegrationHead, "c".repeat(40));
        return workspace;
      },
      createCandidateCommit: () => {
        throw new Error("not used");
      },
      mergeCandidate: () => {
        throw new Error("not used");
      },
      cleanupStoryWorkspace: () => {
        throw new Error("not used");
      },
    },
    expectedIntegrationHead: resolver,
  });

  const evidence = adapter.provision(run, story, 3, "agent-1", baseEvidence());

  assert.equal(requestBranch, run.integrationBranch);
  assert.equal(evidence.git.expectedStoryHead, "b".repeat(40));
});
