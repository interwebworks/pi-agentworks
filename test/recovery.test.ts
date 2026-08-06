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
import {
  assessStartupRecovery,
  reconcileStartupRecovery,
} from "../src/domain/recovery.ts";

function run(): RunState {
  return createRunState({
    id: "run-1",
    title: "Recover interrupted work",
    complexity: "NORMAL",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktrees/run-1/integration",
    createdAt: 1_000,
  });
}

function story(id: string): StoryState {
  return createStoryState({
    id,
    runId: "run-1",
    title: `Story ${id}`,
    branchName: `agentworks/run-1/${id}`,
    worktreePath: `/worktrees/run-1/${id}`,
    createdAt: 1_000,
  });
}

function workingAgent(): AgentState {
  let state = createAgentState({
    id: "agent-1",
    runId: "run-1",
    roleRuntimeId: "software-development/backend-developer",
    taskId: "task-1",
    worktreePath: "/worktrees/run-1/story-1",
    createdAt: 1_000,
  });
  state = transitionAgent(state, {
    type: "launch-requested",
    at: 1_001,
    paneId: "pane-1",
  });
  state = transitionAgent(state, {
    type: "session-ready",
    at: 1_002,
    piSessionPath: "/sessions/agent-1.jsonl",
  });
  return transitionAgent(state, {
    type: "operation-started",
    at: 1_003,
    operation: "Implement story-1",
  });
}

test("fresh and quiescent snapshots are ready without reconciliation", () => {
  assert.deepEqual(assessStartupRecovery(null), {
    status: "ready",
    reasons: [],
  });
  assert.deepEqual(
    assessStartupRecovery({
      run: run(),
      stories: [story("story-1")],
      agents: [],
    }),
    { status: "ready", reasons: [] },
  );
});

test("interrupted agent operations require external reconciliation", () => {
  assert.deepEqual(
    assessStartupRecovery({
      run: run(),
      stories: [story("story-1")],
      agents: [workingAgent()],
    }),
    {
      status: "reconciliation-required",
      reasons: [{ code: "agent-operation-interrupted", entityId: "agent-1" }],
    },
  );
});

test("candidate creation and merge phases remain blocked for evidence reconciliation", () => {
  let candidate = transitionStory(story("story-candidate"), {
    type: "story-prepared",
    at: 1_001,
    complexity: "HIGH",
  });
  candidate = transitionStory(candidate, {
    type: "story-assigned",
    at: 1_002,
    agentId: "agent-1",
  });
  candidate = transitionStory(candidate, {
    type: "story-work-started",
    at: 1_003,
  });
  candidate = transitionStory(candidate, {
    type: "candidate-requested",
    at: 1_004,
    writerLeaseReleased: true,
  });

  const merging: StoryState = {
    ...story("story-merging"),
    status: "merging",
    candidateStoryHead: "story-head",
    reviewedIntegrationHead: "integration-head",
    reviewerAgentId: "reviewer-1",
  };
  assert.deepEqual(
    assessStartupRecovery({
      run: run(),
      stories: [candidate, merging],
      agents: [],
    }),
    {
      status: "reconciliation-required",
      reasons: [
        {
          code: "candidate-commit-interrupted",
          entityId: "story-candidate",
        },
        { code: "merge-interrupted", entityId: "story-merging" },
      ],
    },
  );
});

test("reconciliation clears interrupted phases proven complete by live Git", () => {
  const assessment = {
    status: "reconciliation-required" as const,
    reasons: [
      { code: "candidate-commit-interrupted" as const, entityId: "story-a" },
      { code: "merge-interrupted" as const, entityId: "story-b" },
    ],
  };
  const reconciled = reconcileStartupRecovery(assessment, (reason) =>
    reason.code === "candidate-commit-interrupted"
      ? { candidatePresent: true }
      : { mergePresent: true },
  );
  assert.equal(reconciled.status, "ready");
  assert.deepEqual(
    reconciled.reasons.map((r) => r.disposition),
    ["resolved", "resolved"],
  );
});

test("reconciliation keeps blocking when Git shows the effect never landed", () => {
  const reconciled = reconcileStartupRecovery(
    {
      status: "reconciliation-required",
      reasons: [{ code: "merge-interrupted", entityId: "story-b" }],
    },
    () => ({ mergePresent: false }),
  );
  assert.equal(reconciled.status, "reconciliation-required");
  assert.equal(reconciled.reasons[0]?.disposition, "recovery-required");
});

test("missing live evidence stays unresolved and blocks conservatively", () => {
  const reconciled = reconcileStartupRecovery(
    {
      status: "reconciliation-required",
      reasons: [{ code: "candidate-commit-interrupted", entityId: "story-a" }],
    },
    () => ({}),
  );
  assert.equal(reconciled.status, "reconciliation-required");
  assert.equal(reconciled.reasons[0]?.disposition, "unresolved");
});

test("a terminal run's stale active agent is cleared once its pane is gone", () => {
  const reconciled = reconcileStartupRecovery(
    {
      status: "reconciliation-required",
      reasons: [{ code: "terminal-run-has-active-agent", entityId: "agent-1" }],
    },
    () => ({ paneAlive: false }),
  );
  assert.equal(reconciled.status, "ready");
  assert.equal(reconciled.reasons[0]?.disposition, "resolved");
});

test("a live agent operation still requires recovery regardless of pane state", () => {
  for (const paneAlive of [true, false]) {
    const reconciled = reconcileStartupRecovery(
      {
        status: "reconciliation-required",
        reasons: [{ code: "agent-operation-interrupted", entityId: "agent-1" }],
      },
      () => ({ paneAlive }),
    );
    assert.equal(reconciled.status, "reconciliation-required");
    assert.equal(reconciled.reasons[0]?.disposition, "recovery-required");
  }
});

test("a mixed assessment is ready only when every reason resolves", () => {
  const reconciled = reconcileStartupRecovery(
    {
      status: "reconciliation-required",
      reasons: [
        { code: "candidate-commit-interrupted", entityId: "story-a" },
        { code: "merge-interrupted", entityId: "story-b" },
      ],
    },
    (reason) =>
      reason.code === "candidate-commit-interrupted"
        ? { candidatePresent: true }
        : { mergePresent: false },
  );
  assert.equal(reconciled.status, "reconciliation-required");
  assert.deepEqual(
    reconciled.reasons.map((r) => r.disposition),
    ["resolved", "recovery-required"],
  );
});
