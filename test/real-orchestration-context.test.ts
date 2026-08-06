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
  ControllerRepository,
  WriterLease,
} from "../src/application/ports/controller-repository.ts";
import type {
  GitRepositoryInspection,
  GitRepositoryInspector,
} from "../src/application/ports/git-repository-inspector.ts";
import {
  RealOrchestrationContext,
  RealOrchestrationContextError,
} from "../src/application/orchestration/real-orchestration-context.ts";

function unsupported(): never {
  throw new Error("not used in this test");
}

class FakeRepository implements ControllerRepository {
  lease: WriterLease | null = null;
  acquireLease = unsupported;
  renewLease = unsupported;
  releaseLease = unsupported;
  acquireWriterLease = unsupported;
  renewWriterLease = unsupported;
  releaseWriterLease = unsupported;
  revokeWriterLease = unsupported;
  readWriterLease(): WriterLease | null {
    return this.lease;
  }
  initializeRun = unsupported;
  commitSnapshot = unsupported;
  loadSnapshot = unsupported;
  readEvents = unsupported;
  assertIntegrity = unsupported;
  close = unsupported;
}

function inspection(
  overrides: Partial<GitRepositoryInspection> = {},
): GitRepositoryInspection {
  return {
    requestedPath: "/repo",
    repositoryRoot: "/repo",
    gitDirectory: "/repo/.git",
    commonGitDirectory: "/repo/.git",
    bare: false,
    currentBranch: "main",
    headCommit: "head1",
    localBranches: ["main"],
    defaultBranch: "main",
    defaultBranchSource: "single-local-branch",
    remotes: [],
    repositoryProtectedPatterns: [],
    objectFormat: "sha1",
    ...overrides,
  };
}

class FakeGitInspector implements GitRepositoryInspector {
  result: GitRepositoryInspection = inspection();
  inspect(): GitRepositoryInspection {
    return this.result;
  }
  assertBranchExists = unsupported;
}

function activeRun(integrationBranch = "agentworks/r1/integration"): RunState {
  let run = createRunState({
    id: "r1",
    title: "R",
    complexity: "NORMAL",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch,
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

function approvedStory(): StoryState {
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
  return transitionStory(story, {
    type: "review-approved",
    at: 1007,
    reviewerAgentId: "reviewer-1",
    storyHead: "cafe1",
    integrationHead: "beef1",
    checksPassed: true,
  });
}

function mergedStory(): StoryState {
  const story = transitionStory(approvedStory(), {
    type: "merge-started",
    at: 1008,
  });
  return transitionStory(story, {
    type: "story-merged",
    at: 1009,
    mergeHead: "merge-xyz",
  });
}

test("mergeFacts derives a stable operation id from the candidate commit", () => {
  const repository = new FakeRepository();
  const gitInspector = new FakeGitInspector();
  const context = new RealOrchestrationContext({ repository, gitInspector });
  const story = approvedStory();
  const run = activeRun();

  const facts = context.mergeFacts(story, {
    revision: 1,
    run,
    stories: [story],
    agents: [],
  });
  assert.equal(facts.operationId, "merge-story-1-cafe1");
  assert.equal(facts.subject, "Merge S (story-1)");
  assert.equal(facts.requesterRole, "project-manager");
  assert.equal(facts.requiredChecksPassed, true);
});

test("mergeFacts reports the writer lease as released once it is gone", () => {
  const repository = new FakeRepository();
  const gitInspector = new FakeGitInspector();
  const context = new RealOrchestrationContext({ repository, gitInspector });
  const story = approvedStory();
  const run = activeRun();
  const snapshot = { revision: 1, run, stories: [story], agents: [] };

  repository.lease = {
    runId: "r1",
    storyId: "story-1",
    ownerAgentId: "writer-1",
    leaseToken: 1,
    expiresAt: null,
    updatedAt: 1000,
  };
  assert.equal(context.mergeFacts(story, snapshot).writerLeaseReleased, false);

  repository.lease = { ...repository.lease, ownerAgentId: null };
  assert.equal(context.mergeFacts(story, snapshot).writerLeaseReleased, true);

  repository.lease = null;
  assert.equal(context.mergeFacts(story, snapshot).writerLeaseReleased, true);
});

test("mergeFacts flags a protected or default integration branch", () => {
  const repository = new FakeRepository();
  const gitInspector = new FakeGitInspector();
  const context = new RealOrchestrationContext({ repository, gitInspector });
  const story = approvedStory();

  gitInspector.result = inspection({ defaultBranch: "main" });
  const notProtected = context.mergeFacts(story, {
    revision: 1,
    run: activeRun("agentworks/r1/integration"),
    stories: [story],
    agents: [],
  });
  assert.equal(notProtected.targetIsDefaultOrProtected, false);

  const protectedRun = activeRun("main");
  gitInspector.result = inspection({ defaultBranch: "main" });
  const protectedFacts = context.mergeFacts(story, {
    revision: 1,
    run: protectedRun,
    stories: [story],
    agents: [],
  });
  assert.equal(protectedFacts.targetIsDefaultOrProtected, true);
  assert.equal(protectedFacts.protectedTargetUserApproval, false);
});

test("protectedTargetApproved is consulted for protected-branch approval", () => {
  const repository = new FakeRepository();
  const gitInspector = new FakeGitInspector();
  gitInspector.result = inspection({ defaultBranch: "main" });
  const context = new RealOrchestrationContext({
    repository,
    gitInspector,
    protectedTargetApproved: () => true,
  });
  const story = approvedStory();
  const facts = context.mergeFacts(story, {
    revision: 1,
    run: activeRun("main"),
    stories: [story],
    agents: [],
  });
  assert.equal(facts.protectedTargetUserApproval, true);
});

test("cleanupFacts recomputes the exact merge operation id and subject", () => {
  const repository = new FakeRepository();
  const gitInspector = new FakeGitInspector();
  const context = new RealOrchestrationContext({ repository, gitInspector });
  const story = mergedStory();
  const run = activeRun();
  const snapshot = { revision: 1, run, stories: [story], agents: [] };

  const mergeFacts = context.mergeFacts(approvedStory(), snapshot);
  const cleanupFacts = context.cleanupFacts(story, snapshot);
  assert.equal(cleanupFacts.mergeOperationId, mergeFacts.operationId);
  assert.equal(cleanupFacts.mergeSubject, mergeFacts.subject);
  assert.notEqual(cleanupFacts.operationId, cleanupFacts.mergeOperationId);
});

test("cleanupFacts treats a missing or closed writer agent as closed", () => {
  const repository = new FakeRepository();
  const gitInspector = new FakeGitInspector();
  const context = new RealOrchestrationContext({ repository, gitInspector });
  const story = mergedStory();
  const run = activeRun();

  const noAgent = context.cleanupFacts(story, {
    revision: 1,
    run,
    stories: [story],
    agents: [],
  });
  assert.equal(noAgent.agentClosed, true);

  const openAgent = createAgentState({
    id: "writer-1",
    runId: "r1",
    roleRuntimeId: "software-development/backend-developer",
    taskId: "task-1",
    worktreePath: story.worktreePath,
    createdAt: 1000,
  });
  const withOpenAgent = context.cleanupFacts(story, {
    revision: 1,
    run,
    stories: [story],
    agents: [openAgent],
  });
  assert.equal(withOpenAgent.agentClosed, false);
});

test("facts throw a clear error when the story has no candidate commit yet", () => {
  const repository = new FakeRepository();
  const gitInspector = new FakeGitInspector();
  const context = new RealOrchestrationContext({ repository, gitInspector });
  const story = createStoryState({
    id: "story-1",
    runId: "r1",
    title: "S",
    branchName: "agentworks/r1/story-1",
    worktreePath: "/wt/r1/story-1",
    createdAt: 1000,
  });
  assert.throws(
    () =>
      context.mergeFacts(story, {
        revision: 1,
        run: activeRun(),
        stories: [story],
        agents: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof RealOrchestrationContextError);
      assert.match(error.message, /no candidate commit yet/u);
      return true;
    },
  );
});
