import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionRun,
  transitionStory,
  type RunState,
  type StoryState,
} from "../src/domain/controller-state.ts";
import type {
  CleanupStoryWorkspaceRequest,
  GitWorkspaceGateway,
  MergeCandidateRequest,
} from "../src/application/ports/git-workspace-gateway.ts";
import type { ControllerSnapshot } from "../src/application/ports/controller-repository.ts";
import type { OrchestrationContext } from "../src/application/ports/orchestration-context.ts";
import type { StoryAgentLauncher } from "../src/application/ports/story-agent-launcher.ts";
import {
  ControllerOrchestrationEffects,
  ControllerOrchestrationEffectsError,
} from "../src/application/orchestration/controller-orchestration-effects.ts";

function unsupported(): never {
  throw new Error("not used in this test");
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  assert.ok(item);
  return item;
}

class RecordingGit implements GitWorkspaceGateway {
  merge: MergeCandidateRequest | null = null;
  cleanup: CleanupStoryWorkspaceRequest | null = null;
  listWorktrees = unsupported;
  createIntegrationWorkspace = unsupported;
  createStoryWorkspace = unsupported;
  createCandidateCommit = unsupported;
  mergeCandidate(request: MergeCandidateRequest) {
    this.merge = request;
    return {
      status: "created" as const,
      mergeCommit: "merge-xyz",
      integrationParent: request.reviewedIntegrationHead,
      candidateParent: request.candidateCommit,
      tree: "tree-1",
    };
  }
  cleanupStoryWorkspace(request: CleanupStoryWorkspaceRequest) {
    this.cleanup = request;
    return {
      status: "removed" as const,
      worktreeAbsent: true,
      branchAbsent: true,
      mergeCommit: request.mergeCommit,
    };
  }
}

const mergeFacts = {
  operationId: "merge-op-1",
  requesterRole: "project-manager",
  subject: "Merge story-1",
  requiredChecksPassed: true,
  writerLeaseReleased: true,
  controllerLeaseCurrent: true,
  expectedRevisionMatches: true,
  targetIsDefaultOrProtected: false,
  protectedTargetUserApproval: false,
};

const cleanupFacts = {
  operationId: "cleanup-op-1",
  mergeOperationId: "merge-op-1",
  mergeSubject: "Merge story-1",
  writerLeaseReleased: true,
  agentClosed: true,
  controllerLeaseCurrent: true,
  expectedRevisionMatches: true,
};

const context: OrchestrationContext = {
  mergeFacts: () => mergeFacts,
  cleanupFacts: () => cleanupFacts,
};

const launcher: StoryAgentLauncher = {
  launchWriter: (story) =>
    Promise.resolve({
      agent: createAgentState({
        id: "writer-1",
        runId: "r1",
        roleRuntimeId: "software-development/backend-developer",
        taskId: `task-${story.id}`,
        worktreePath: story.worktreePath,
        createdAt: 3000,
      }),
      events: [],
    }),
  launchReviewer: (story) =>
    Promise.resolve({
      agent: createAgentState({
        id: "reviewer-1",
        runId: "r1",
        roleRuntimeId: "software-development/code-reviewer",
        taskId: `review-${story.id}`,
        worktreePath: story.worktreePath,
        createdAt: 3000,
      }),
      events: [],
    }),
};

function activeRun(): RunState {
  let run = createRunState({
    id: "r1",
    title: "R",
    complexity: "NORMAL",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/r1/integration",
    integrationWorktree: "/wt/r1/integration",
    createdAt: 1000,
  });
  run = transitionRun(run, { type: "plan-prepared", at: 1001 });
  run = transitionRun(run, { type: "plan-approved", at: 1002 });
  return transitionRun(run, {
    type: "run-started",
    at: 1003,
    integrationWorktreeReady: true,
  });
}

function storyAt(status: "ready" | "approved" | "merged"): StoryState {
  let story = createStoryState({
    id: "story-1",
    runId: "r1",
    title: "S",
    branchName: "agentworks/r1/story-1",
    worktreePath: "/wt/r1/story-1",
    createdAt: 1000,
  });
  story = transitionStory(story, {
    type: "story-prepared",
    at: 1001,
    complexity: "NORMAL",
  });
  story = transitionStory(story, { type: "story-plan-approved", at: 1002 });
  if (status === "ready") return story;
  story = transitionStory(story, {
    type: "story-assigned",
    at: 1003,
    agentId: "writer-1",
  });
  story = transitionStory(story, { type: "story-work-started", at: 1004 });
  story = transitionStory(story, {
    type: "candidate-requested",
    at: 1005,
    writerLeaseReleased: true,
  });
  story = transitionStory(story, {
    type: "candidate-created",
    at: 1006,
    storyHead: "cafe1",
    integrationHead: "beef1",
  });
  story = transitionStory(story, {
    type: "review-approved",
    at: 1007,
    reviewerAgentId: "reviewer-1",
    storyHead: "cafe1",
    integrationHead: "beef1",
    checksPassed: true,
  });
  if (status === "approved") return story;
  story = transitionStory(story, { type: "merge-started", at: 1008 });
  return transitionStory(story, {
    type: "story-merged",
    at: 1009,
    mergeHead: "merge-xyz",
  });
}

function snapshot(story: StoryState): ControllerSnapshot {
  return { revision: 1, run: activeRun(), stories: [story], agents: [] };
}

function effects(git: RecordingGit): ControllerOrchestrationEffects {
  let now = 3000;
  return new ControllerOrchestrationEffects({
    git,
    launcher,
    context,
    clock: () => (now += 1),
  });
}

test("request-merge assembles the exact merge request and merges the story", async () => {
  const git = new RecordingGit();
  const result = await effects(git).execute(
    { type: "request-merge", storyId: "story-1" },
    snapshot(storyAt("approved")),
  );

  const request = git.merge;
  assert.ok(request);
  assert.equal(request.runId, "r1");
  assert.equal(request.storyId, "story-1");
  assert.equal(request.operationId, "merge-op-1");
  assert.equal(request.originalCheckout, "/repo");
  assert.equal(request.integrationBranch, "agentworks/r1/integration");
  assert.equal(request.integrationWorktreePath, "/wt/r1/integration");
  assert.equal(request.reviewedIntegrationHead, "beef1");
  assert.equal(request.storyBranch, "agentworks/r1/story-1");
  assert.equal(request.storyWorktreePath, "/wt/r1/story-1");
  assert.equal(request.candidateCommit, "cafe1");
  assert.equal(request.writerAgentId, "writer-1");
  assert.equal(request.reviewerAgentId, "reviewer-1");
  assert.equal(request.requesterRole, "project-manager");
  assert.equal(request.requiredChecksPassed, true);
  assert.equal(request.targetIsDefaultOrProtected, false);

  const merged = first(result.stories);
  assert.equal(merged.status, "merged");
  assert.equal(merged.mergeHead, "merge-xyz");
});

test("request-cleanup assembles the cleanup request from merged state", async () => {
  const git = new RecordingGit();
  await effects(git).execute(
    { type: "request-cleanup", storyId: "story-1" },
    snapshot(storyAt("merged")),
  );
  const request = git.cleanup;
  assert.ok(request);
  assert.equal(request.candidateCommit, "cafe1");
  assert.equal(request.mergeCommit, "merge-xyz");
  assert.equal(request.reviewedIntegrationHead, "beef1");
  assert.equal(request.reviewerAgentId, "reviewer-1");
  assert.equal(request.operationId, "cleanup-op-1");
  assert.equal(request.agentClosed, true);
});

test("assign-story launches a writer and marks the story assigned", async () => {
  const git = new RecordingGit();
  const result = await effects(git).execute(
    { type: "assign-story", storyId: "story-1" },
    snapshot(storyAt("ready")),
  );
  const assigned = first(result.stories);
  assert.equal(assigned.status, "assigned");
  assert.equal(assigned.assignedAgentId, "writer-1");
  assert.equal(
    result.agents.some((a) => a.id === "writer-1"),
    true,
  );
});

test("assign-reviewer persists the assignment without changing story status", async () => {
  const git = new RecordingGit();
  const story = storyAt("approved"); // any awaiting-review-ish story is fine
  const result = await effects(git).execute(
    { type: "assign-reviewer", storyId: "story-1" },
    snapshot(story),
  );
  const assigned = first(result.stories);
  assert.equal(assigned.status, story.status);
  assert.equal(assigned.reviewerAgentId, "reviewer-1");
  assert.equal(
    result.agents.some((a) => a.id === "reviewer-1"),
    true,
  );
});

test("complete-run completes the run with computed unfinished stories", async () => {
  const git = new RecordingGit();
  const result = await effects(git).execute(
    { type: "complete-run" },
    snapshot(storyAt("merged")),
  );
  assert.equal(result.run.status, "completed");
});

test("request-merge fails closed when review evidence is missing", async () => {
  const git = new RecordingGit();
  await assert.rejects(
    effects(git).execute(
      { type: "request-merge", storyId: "story-1" },
      snapshot(storyAt("ready")),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ControllerOrchestrationEffectsError);
      assert.match(error.message, /not ready to merge/u);
      return true;
    },
  );
  assert.equal(git.merge, null);
});
