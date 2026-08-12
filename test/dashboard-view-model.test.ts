import assert from "node:assert/strict";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionAgent,
  transitionStory,
  type AgentState,
  type RunState,
  type StoryState,
} from "../src/domain/controller-state.ts";
import type {
  ControllerEventRecord,
  ControllerSnapshot,
} from "../src/application/ports/controller-repository.ts";
import {
  attentionForAgent,
  attentionForStory,
  buildDashboardViewModel,
  formatElapsedDuration,
} from "../src/application/tui/dashboard-view-model.ts";

function run(): RunState {
  return createRunState({
    id: "run-1",
    title: "Ship P7",
    complexity: "NORMAL",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktrees/run-1/integration",
    createdAt: 1_000,
  });
}

function plannedStory(id: string): StoryState {
  return createStoryState({
    id,
    runId: "run-1",
    title: `Story ${id}`,
    branchName: `agentworks/run-1/${id}`,
    worktreePath: `/worktrees/run-1/${id}`,
    createdAt: 1_000,
  });
}

function blockedStory(id: string): StoryState {
  const prepared = transitionStory(plannedStory(id), {
    type: "story-prepared",
    at: 1_001,
    complexity: "NORMAL",
  });
  const approved = transitionStory(prepared, {
    type: "story-plan-approved",
    at: 1_002,
  });
  const assigned = transitionStory(approved, {
    type: "story-assigned",
    at: 1_002,
    agentId: "agent-1",
  });
  const working = transitionStory(assigned, {
    type: "story-work-started",
    at: 1_003,
  });
  const awaitingCandidate = transitionStory(working, {
    type: "candidate-requested",
    at: 1_004,
    writerLeaseReleased: true,
  });
  const awaitingReview = transitionStory(awaitingCandidate, {
    type: "candidate-created",
    at: 1_005,
    storyHead: "story-head-1",
    integrationHead: "integration-head-1",
  });
  return transitionStory(awaitingReview, {
    type: "review-changes-requested",
    at: 1_006,
    reviewerAgentId: "agent-2",
  });
}

function workingAgent(): AgentState {
  const launched = transitionAgent(
    createAgentState({
      id: "agent-1",
      runId: "run-1",
      roleRuntimeId: "software-development/backend-developer",
      taskId: "task-1",
      worktreePath: "/worktrees/run-1/story-1",
      createdAt: 1_000,
    }),
    { type: "launch-requested", at: 1_001, paneId: "pane-1" },
  );
  const ready = transitionAgent(launched, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });
  return transitionAgent(ready, {
    type: "operation-started",
    at: 1_003,
    operation: "Implement story-1",
  });
}

function blockedAgent(): AgentState {
  const launched = transitionAgent(
    createAgentState({
      id: "agent-2",
      runId: "run-1",
      roleRuntimeId: "software-development/reviewer",
      taskId: null,
      worktreePath: "/worktrees/run-1/story-2",
      createdAt: 1_000,
    }),
    { type: "launch-requested", at: 1_001, paneId: "pane-2" },
  );
  const idle = transitionAgent(launched, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-2.jsonl",
  });
  return transitionAgent(idle, {
    type: "agent-blocked",
    at: 1_003,
    reason: "sandbox denied write",
  });
}

function snapshot(): ControllerSnapshot {
  return Object.freeze({
    revision: 7,
    run: run(),
    stories: Object.freeze([plannedStory("story-1"), blockedStory("story-2")]),
    agents: Object.freeze([workingAgent(), blockedAgent()]),
  });
}

test("attentionForStory maps statuses to attention levels", () => {
  assert.equal(attentionForStory("blocked"), "critical");
  assert.equal(attentionForStory("failed"), "critical");
  assert.equal(attentionForStory("awaiting-review"), "warn");
  assert.equal(attentionForStory("changes-requested"), "warn");
  assert.equal(attentionForStory("working"), "info");
  assert.equal(attentionForStory("merging"), "info");
  assert.equal(attentionForStory("merged"), "normal");
  assert.equal(attentionForStory("work-complete"), "info");
  assert.equal(attentionForStory("planned"), "normal");
});

test("attentionForAgent maps statuses to attention levels", () => {
  assert.equal(attentionForAgent("blocked"), "critical");
  assert.equal(attentionForAgent("failed"), "critical");
  assert.equal(attentionForAgent("waiting"), "warn");
  assert.equal(attentionForAgent("disconnected"), "warn");
  assert.equal(attentionForAgent("working"), "info");
  assert.equal(attentionForAgent("reviewing"), "info");
  assert.equal(attentionForAgent("completed"), "normal");
  assert.equal(attentionForAgent("idle"), "normal");
});

test("buildDashboardViewModel projects run header, story rows, and agent rows", () => {
  const viewModel = buildDashboardViewModel(snapshot());

  assert.equal(viewModel.revision, 7);
  assert.deepEqual(viewModel.run, {
    id: "run-1",
    title: "Ship P7",
    complexity: "NORMAL",
    status: "planning",
    blockedReason: null,
    storyStatusCounts: {
      planned: 1,
      "awaiting-approval": 0,
      ready: 0,
      assigned: 0,
      working: 0,
      "work-complete": 0,
      "awaiting-candidate": 0,
      "awaiting-review": 0,
      "changes-requested": 1,
      approved: 0,
      merging: 0,
      merged: 0,
      blocked: 0,
      failed: 0,
    },
  });

  assert.equal(viewModel.stories.length, 2);
  assert.deepEqual(viewModel.stories[0], {
    id: "story-1",
    title: "Story story-1",
    status: "planned",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktrees/run-1/story-1",
    assignedAgentId: null,
    reviewerAgentId: null,
    attention: "normal",
  });
  assert.deepEqual(viewModel.stories[1], {
    id: "story-2",
    title: "Story story-2",
    status: "changes-requested",
    branchName: "agentworks/run-1/story-2",
    worktreePath: "/worktrees/run-1/story-2",
    assignedAgentId: "agent-1",
    reviewerAgentId: "agent-2",
    attention: "warn",
  });

  assert.equal(viewModel.agents.length, 2);
  assert.deepEqual(viewModel.agents[0], {
    id: "agent-1",
    role: "software-development/backend-developer",
    status: "working",
    currentOperation: "Implement story-1",
    paneId: "pane-1",
    attention: "info",
  });
  assert.deepEqual(viewModel.agents[1], {
    id: "agent-2",
    role: "software-development/reviewer",
    status: "blocked",
    currentOperation: null,
    paneId: "pane-2",
    attention: "critical",
  });
});

test("buildDashboardViewModel projects a durable run block reason", () => {
  const blocked = {
    ...snapshot(),
    run: {
      ...snapshot().run,
      status: "blocked" as const,
      blockedReason: "initial orchestration failed: Herdr unavailable",
    },
  };
  const viewModel = buildDashboardViewModel(blocked);
  assert.equal(
    viewModel.run.blockedReason,
    "initial orchestration failed: Herdr unavailable",
  );
});

test("buildDashboardViewModel projects durable supervisor attention", () => {
  const event: ControllerEventRecord = {
    eventId: "event-1",
    runId: "run-1",
    revision: 4,
    eventIndex: 1,
    type: "supervisor-attention-required",
    entityType: "agent",
    entityId: "agent-2",
    payload: { reason: "needs approval" },
    occurredAt: 4_000,
  };
  const viewModel = buildDashboardViewModel(snapshot(), [event]);
  assert.deepEqual(viewModel.supervisorAttention, [
    {
      eventId: "event-1",
      agentId: "agent-2",
      reason: "needs approval",
      occurredAt: 4_000,
    },
  ]);
});

test("buildDashboardViewModel reports stale working agents without changing state", () => {
  const viewModel = buildDashboardViewModel(snapshot(), [], {
    now: 301_004,
    staleProgressThresholdMs: 300_000,
  });

  assert.deepEqual(viewModel.staleAgents, [
    {
      agentId: "agent-1",
      role: "software-development/backend-developer",
      status: "working",
      staleForMs: 300_001,
      lastMeaningfulActivityAt: 1_003,
    },
  ]);
  assert.equal(viewModel.agents[0]?.status, "working");
  assert.equal(formatElapsedDuration(3_960_000), "1h 6m");
});

test("buildDashboardViewModel output is deeply frozen", () => {
  const viewModel = buildDashboardViewModel(snapshot());
  assert.ok(Object.isFrozen(viewModel));
  assert.ok(Object.isFrozen(viewModel.run));
  assert.ok(Object.isFrozen(viewModel.run.storyStatusCounts));
  assert.ok(Object.isFrozen(viewModel.stories));
  assert.ok(Object.isFrozen(viewModel.stories[0]));
  assert.ok(Object.isFrozen(viewModel.agents));
  assert.ok(Object.isFrozen(viewModel.agents[0]));
});
