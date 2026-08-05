import assert from "node:assert/strict";
import test from "node:test";
import {
  assessAgentLiveness,
  CONTROLLER_STATE_SCHEMA_VERSION,
  createAgentState,
  createRunState,
  createStoryState,
  InvalidStateTransitionError,
  transitionAgent,
  transitionRun,
  transitionStory,
  type AgentState,
  type RunState,
  type StoryState,
} from "../src/domain/controller-state.ts";

function run(complexity: "LOW" | "NORMAL" | "HIGH" = "NORMAL"): RunState {
  return createRunState({
    id: "run-1",
    title: "Implement approved feature",
    complexity,
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktrees/run-1/integration",
    createdAt: 1_000,
  });
}

function story(): StoryState {
  return createStoryState({
    id: "story-1",
    runId: "run-1",
    title: "Add the API contract",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktrees/run-1/story-1",
    createdAt: 1_000,
  });
}

function agent(): AgentState {
  return createAgentState({
    id: "agent-1",
    runId: "run-1",
    roleRuntimeId: "software-development/backend-developer",
    taskId: "task-1",
    worktreePath: "/worktrees/run-1/story-1",
    createdAt: 1_000,
  });
}

test("LOW and NORMAL plans wait for approval while HIGH becomes ready", () => {
  assert.equal(run().schemaVersion, CONTROLLER_STATE_SCHEMA_VERSION);
  assert.equal(story().schemaVersion, CONTROLLER_STATE_SCHEMA_VERSION);
  assert.equal(agent().schemaVersion, CONTROLLER_STATE_SCHEMA_VERSION);
  assert.equal(
    transitionRun(run("LOW"), { type: "plan-prepared", at: 1_001 }).status,
    "awaiting-approval",
  );
  assert.equal(
    transitionRun(run("NORMAL"), { type: "plan-prepared", at: 1_001 }).status,
    "awaiting-approval",
  );
  assert.equal(
    transitionRun(run("HIGH"), { type: "plan-prepared", at: 1_001 }).status,
    "ready",
  );
});

test("a run cannot start before its integration worktree is ready", () => {
  const awaitingApproval = transitionRun(run(), {
    type: "plan-prepared",
    at: 1_001,
  });
  const ready = transitionRun(awaitingApproval, {
    type: "plan-approved",
    at: 1_002,
  });

  assert.throws(
    () =>
      transitionRun(ready, {
        type: "run-started",
        at: 1_003,
        integrationWorktreeReady: false,
      }),
    /integration worktree is not ready/u,
  );
});

test("a run cannot complete while stories remain unfinished", () => {
  const ready = transitionRun(run("HIGH"), {
    type: "plan-prepared",
    at: 1_001,
  });
  const active = transitionRun(ready, {
    type: "run-started",
    at: 1_002,
    integrationWorktreeReady: true,
  });

  assert.throws(
    () =>
      transitionRun(active, {
        type: "run-completed",
        at: 1_003,
        unfinishedStoryIds: ["story-1"],
      }),
    /unfinished stories: story-1/u,
  );

  const completed = transitionRun(active, {
    type: "run-completed",
    at: 1_003,
    unfinishedStoryIds: [],
  });
  assert.equal(completed.status, "completed");
  assert.throws(
    () =>
      transitionRun(completed, {
        type: "run-failed",
        at: 1_004,
        reason: "late failure",
      }),
    InvalidStateTransitionError,
  );
});

test("a blocked run records and clears its reason when resumed", () => {
  const ready = transitionRun(run("HIGH"), {
    type: "plan-prepared",
    at: 1_001,
  });
  const active = transitionRun(ready, {
    type: "run-started",
    at: 1_002,
    integrationWorktreeReady: true,
  });
  const blocked = transitionRun(active, {
    type: "run-blocked",
    at: 1_003,
    reason: "User decision required",
  });
  assert.equal(blocked.blockedReason, "User decision required");

  const resumed = transitionRun(blocked, { type: "run-resumed", at: 1_004 });
  assert.equal(resumed.status, "active");
  assert.equal(resumed.blockedReason, null);
});

test("a story follows prepared, assigned, candidate, review, and merge states", () => {
  let current = transitionStory(story(), {
    type: "story-prepared",
    at: 1_001,
    complexity: "NORMAL",
  });
  assert.equal(current.status, "awaiting-approval");
  current = transitionStory(current, {
    type: "story-plan-approved",
    at: 1_002,
  });
  current = transitionStory(current, {
    type: "story-assigned",
    at: 1_003,
    agentId: "agent-1",
  });
  current = transitionStory(current, { type: "story-work-started", at: 1_004 });
  current = transitionStory(current, {
    type: "candidate-requested",
    at: 1_005,
    writerLeaseReleased: true,
  });
  current = transitionStory(current, {
    type: "candidate-created",
    at: 1_006,
    storyHead: "story-head-1",
    integrationHead: "integration-head-1",
  });
  current = transitionStory(current, {
    type: "review-approved",
    at: 1_007,
    reviewerAgentId: "reviewer-1",
    storyHead: "story-head-1",
    integrationHead: "integration-head-1",
    checksPassed: true,
  });
  assert.equal(current.status, "approved");
  assert.equal(current.reviewerAgentId, "reviewer-1");
  current = transitionStory(current, { type: "merge-started", at: 1_008 });
  current = transitionStory(current, {
    type: "story-merged",
    at: 1_009,
    mergeHead: "integration-head-2",
  });
  assert.equal(current.status, "merged");
  assert.equal(current.mergeHead, "integration-head-2");
});

test("review approval must match the exact candidate and integration HEAD", () => {
  let current = transitionStory(story(), {
    type: "story-prepared",
    at: 1_001,
    complexity: "HIGH",
  });
  current = transitionStory(current, {
    type: "story-assigned",
    at: 1_002,
    agentId: "agent-1",
  });
  current = transitionStory(current, { type: "story-work-started", at: 1_003 });
  current = transitionStory(current, {
    type: "candidate-requested",
    at: 1_004,
    writerLeaseReleased: true,
  });
  current = transitionStory(current, {
    type: "candidate-created",
    at: 1_005,
    storyHead: "story-head-1",
    integrationHead: "integration-head-1",
  });

  assert.throws(
    () =>
      transitionStory(current, {
        type: "review-approved",
        at: 1_006,
        reviewerAgentId: "reviewer-1",
        storyHead: "story-head-2",
        integrationHead: "integration-head-1",
        checksPassed: true,
      }),
    /reviewed story HEAD does not match candidate/u,
  );
});

test("requested changes invalidate candidate evidence when work restarts", () => {
  let current = transitionStory(story(), {
    type: "story-prepared",
    at: 1_001,
    complexity: "HIGH",
  });
  current = transitionStory(current, {
    type: "story-assigned",
    at: 1_002,
    agentId: "agent-1",
  });
  current = transitionStory(current, { type: "story-work-started", at: 1_003 });
  current = transitionStory(current, {
    type: "candidate-requested",
    at: 1_004,
    writerLeaseReleased: true,
  });
  current = transitionStory(current, {
    type: "candidate-created",
    at: 1_005,
    storyHead: "story-head-1",
    integrationHead: "integration-head-1",
  });
  current = transitionStory(current, {
    type: "review-changes-requested",
    at: 1_006,
    reviewerAgentId: "reviewer-1",
  });
  current = transitionStory(current, { type: "story-work-started", at: 1_007 });

  assert.equal(current.status, "working");
  assert.equal(current.candidateStoryHead, null);
  assert.equal(current.reviewedIntegrationHead, null);
  assert.equal(current.reviewerAgentId, null);
});

test("story reassignment requires prior writer lease release", () => {
  const ready = transitionStory(story(), {
    type: "story-prepared",
    at: 1_001,
    complexity: "HIGH",
  });
  const assigned = transitionStory(ready, {
    type: "story-assigned",
    at: 1_002,
    agentId: "agent-1",
  });
  const working = transitionStory(assigned, {
    type: "story-work-started",
    at: 1_003,
  });
  assert.throws(
    () =>
      transitionStory(working, {
        type: "candidate-requested",
        at: 1_004,
        writerLeaseReleased: false,
      }),
    /writer lease is still active/u,
  );
  assert.throws(
    () =>
      transitionStory(working, {
        type: "story-reassignment-requested",
        at: 1_004,
        reason: "agent disconnected",
        writerLeaseReleased: false,
      }),
    /writer lease is still active/u,
  );

  const unassigned = transitionStory(working, {
    type: "story-reassignment-requested",
    at: 1_004,
    reason: "agent disconnected",
    writerLeaseReleased: true,
  });
  assert.equal(unassigned.status, "ready");
  assert.equal(unassigned.assignedAgentId, null);
  const reassigned = transitionStory(unassigned, {
    type: "story-assigned",
    at: 1_005,
    agentId: "agent-2",
  });
  assert.equal(reassigned.assignedAgentId, "agent-2");
});

test("story blocking preserves the exact state to resume", () => {
  const ready = transitionStory(story(), {
    type: "story-prepared",
    at: 1_001,
    complexity: "HIGH",
  });
  const assigned = transitionStory(ready, {
    type: "story-assigned",
    at: 1_002,
    agentId: "agent-1",
  });
  const blocked = transitionStory(assigned, {
    type: "story-blocked",
    at: 1_003,
    reason: "Dependency unavailable",
  });
  assert.equal(blocked.blockedFrom, "assigned");

  const resumed = transitionStory(blocked, {
    type: "story-resumed",
    at: 1_004,
  });
  assert.equal(resumed.status, "assigned");
  assert.equal(resumed.blockedReason, null);
  assert.equal(resumed.blockedFrom, null);
});

test("an agent has an explicit launch, session, work, completion, and close lifecycle", () => {
  let current = transitionAgent(agent(), {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  current = transitionAgent(current, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });
  current = transitionAgent(current, {
    type: "operation-started",
    at: 1_003,
    operation: "Implement task-1",
  });
  assert.equal(current.status, "working");
  current = transitionAgent(current, { type: "operation-finished", at: 1_004 });
  current = transitionAgent(current, { type: "agent-completed", at: 1_005 });
  current = transitionAgent(current, {
    type: "agent-closed",
    at: 1_006,
    writerLeaseReleased: true,
  });
  assert.equal(current.status, "closed");
  assert.equal(current.paneId, null);
});

test("pane loss disconnects rather than completes an agent and permits recovery", () => {
  let current = transitionAgent(agent(), {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  current = transitionAgent(current, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });
  current = transitionAgent(current, { type: "pane-lost", at: 1_003 });
  assert.equal(current.status, "disconnected");
  assert.equal(current.paneId, null);

  current = transitionAgent(current, {
    type: "recovery-requested",
    at: 1_004,
    paneId: "pane-2",
  });
  assert.equal(current.status, "launching");
  assert.equal(current.currentOperation, "restoring Pi session");
});

test("agent closure fails while a writer lease remains active", () => {
  let current = transitionAgent(agent(), {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  current = transitionAgent(current, {
    type: "agent-failed",
    at: 1_002,
    reason: "Model error",
  });

  assert.throws(
    () =>
      transitionAgent(current, {
        type: "agent-closed",
        at: 1_003,
        writerLeaseReleased: false,
      }),
    /writer lease is still active/u,
  );
});

test("liveness only nudges idle agents after bounded backoff and then escalates", () => {
  let current = transitionAgent(agent(), {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  current = transitionAgent(current, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });

  assert.equal(assessAgentLiveness(current, 91_001).action, "none");
  assert.deepEqual(assessAgentLiveness(current, 91_002), {
    action: "nudge",
    attempt: 1,
  });

  current = transitionAgent(current, { type: "nudge-sent", at: 91_002 });
  assert.deepEqual(assessAgentLiveness(current, 181_002), {
    action: "nudge",
    attempt: 2,
  });
  current = transitionAgent(current, { type: "nudge-sent", at: 181_002 });
  assert.deepEqual(assessAgentLiveness(current, 361_002), {
    action: "nudge",
    attempt: 3,
  });
  current = transitionAgent(current, { type: "nudge-sent", at: 361_002 });
  assert.deepEqual(assessAgentLiveness(current, 661_002), {
    action: "escalate",
    reason: "bounded liveness nudges exhausted",
  });
});

test("heartbeats prove process life but do not postpone an idle progress nudge", () => {
  let current = transitionAgent(agent(), {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  current = transitionAgent(current, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });
  current = transitionAgent(current, { type: "heartbeat", at: 90_000 });

  assert.equal(current.lastHeartbeatAt, 90_000);
  assert.equal(current.lastMeaningfulActivityAt, 1_002);
  assert.deepEqual(assessAgentLiveness(current, 91_002), {
    action: "nudge",
    attempt: 1,
  });
});

test("waiting, blocked, working, and reviewing agents are never liveness-nudged", () => {
  let idle = transitionAgent(agent(), {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  idle = transitionAgent(idle, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });

  const waiting = transitionAgent(idle, {
    type: "waiting-for-input",
    at: 1_003,
    reason: "Supervisor decision",
  });
  const working = transitionAgent(idle, {
    type: "operation-started",
    at: 1_003,
    operation: "Run tests",
  });
  const reviewing = transitionAgent(idle, {
    type: "review-started",
    at: 1_003,
    operation: "Review story-1",
  });
  const blocked = transitionAgent(idle, {
    type: "agent-blocked",
    at: 1_003,
    reason: "Dependency failed",
  });

  for (const state of [waiting, working, reviewing, blocked]) {
    assert.equal(assessAgentLiveness(state, 1_000_000).action, "none");
  }
});

test("transition timestamps cannot move backwards", () => {
  assert.throws(
    () => transitionRun(run(), { type: "plan-prepared", at: 999 }),
    /timestamp cannot move backwards/u,
  );
});
