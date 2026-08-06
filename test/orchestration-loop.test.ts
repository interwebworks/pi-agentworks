import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentState,
  createRunState,
  createStoryState,
  transitionRun,
  transitionStory,
  type AgentState,
  type RunState,
  type StoryState,
} from "../src/domain/controller-state.ts";
import type { OrchestrationAction } from "../src/domain/orchestration.ts";
import type {
  ControllerEventInput,
  ControllerSnapshot,
} from "../src/application/ports/controller-repository.ts";
import type { OrchestrationEffects } from "../src/application/ports/orchestration-effects.ts";
import { OrchestrationLoop } from "../src/application/orchestration/orchestration-loop.ts";
import { SqliteControllerRepository } from "../src/infrastructure/controller/sqlite-controller-repository.ts";

function createFixture(): {
  readonly directory: string;
  readonly repository: SqliteControllerRepository;
} {
  const directory = mkdtempSync(join(tmpdir(), "agentworks-orchestration-"));
  return {
    directory,
    repository: new SqliteControllerRepository(
      join(directory, "runtime", "controller.sqlite"),
    ),
  };
}

function activeRun(): RunState {
  const planning = createRunState({
    id: "run-1",
    title: "Ship the feature",
    complexity: "HIGH",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktrees/run-1/integration",
    createdAt: 1_000,
  });
  const ready = transitionRun(planning, { type: "plan-prepared", at: 1_001 });
  return transitionRun(ready, {
    type: "run-started",
    at: 1_002,
    integrationWorktreeReady: true,
  });
}

function readyStory(): StoryState {
  const planned = createStoryState({
    id: "story-1",
    runId: "run-1",
    title: "Implement the thing",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktrees/run-1/story-1",
    createdAt: 1_000,
  });
  return transitionStory(planned, {
    type: "story-prepared",
    at: 1_001,
    complexity: "HIGH",
  });
}

function plannedAgents(): readonly AgentState[] {
  return [
    createAgentState({
      id: "agent-1",
      runId: "run-1",
      roleRuntimeId: "software-development/backend-developer",
      taskId: "story-1",
      worktreePath: "/worktrees/run-1/story-1",
      createdAt: 1_000,
    }),
    createAgentState({
      id: "agent-2",
      runId: "run-1",
      roleRuntimeId: "software-development/reviewer",
      taskId: null,
      worktreePath: "/worktrees/run-1/story-1",
      createdAt: 1_000,
    }),
  ];
}

function mustFind<T extends { readonly id: string }>(
  items: readonly T[],
  id: string,
): T {
  const found = items.find((item) => item.id === id);
  assert.ok(found, `expected to find ${id}`);
  return found;
}

function replace<T extends { readonly id: string }>(
  items: readonly T[],
  next: T,
): readonly T[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

function event(
  type: string,
  entityType: ControllerEventInput["entityType"],
  entityId: string,
  occurredAt: number,
): ControllerEventInput {
  return {
    eventId: `${type}-${entityId}-${String(occurredAt)}`,
    type,
    entityType,
    entityId,
    payload: {},
    occurredAt,
  };
}

/**
 * Stands in for the real Git/launcher adapter. It applies deterministic,
 * domain-valid transitions for each action so the loop's fold-and-commit
 * sequencing can be exercised without any real process or Git I/O.
 */
class FakeEffects implements OrchestrationEffects {
  readonly applied: OrchestrationAction["type"][] = [];
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async execute(
    action: OrchestrationAction,
    snapshot: ControllerSnapshot,
  ): Promise<{
    readonly run: RunState;
    readonly stories: readonly StoryState[];
    readonly agents: readonly AgentState[];
    readonly events: readonly ControllerEventInput[];
  }> {
    this.applied.push(action.type);
    const at = this.#now();
    switch (action.type) {
      case "assign-story": {
        const story = mustFind(snapshot.stories, action.storyId);
        const nextStory = transitionStory(story, {
          type: "story-assigned",
          at,
          agentId: "agent-1",
        });
        const agent = mustFind(snapshot.agents, "agent-1");
        const nextAgent: AgentState = {
          ...agent,
          status: "working",
          currentOperation: "writing story-1",
          updatedAt: at,
        };
        return {
          run: snapshot.run,
          stories: replace(snapshot.stories, nextStory),
          agents: replace(snapshot.agents, nextAgent),
          events: [event("story-assigned", "story", action.storyId, at)],
        };
      }
      case "assign-reviewer": {
        const story = mustFind(snapshot.stories, action.storyId);
        const nextStory: StoryState = {
          ...story,
          reviewerAgentId: "agent-2",
          updatedAt: at,
        };
        return {
          run: snapshot.run,
          stories: replace(snapshot.stories, nextStory),
          agents: snapshot.agents,
          events: [event("reviewer-assigned", "story", action.storyId, at)],
        };
      }
      case "request-merge": {
        const story = mustFind(snapshot.stories, action.storyId);
        const merging = transitionStory(story, { type: "merge-started", at });
        const merged = transitionStory(merging, {
          type: "story-merged",
          at,
          mergeHead: "deadbeef",
        });
        return {
          run: snapshot.run,
          stories: replace(snapshot.stories, merged),
          agents: snapshot.agents,
          events: [event("story-merged", "story", action.storyId, at)],
        };
      }
      case "request-cleanup": {
        return {
          run: snapshot.run,
          stories: snapshot.stories,
          agents: snapshot.agents,
          events: [event("cleanup-requested", "story", action.storyId, at)],
        };
      }
      case "complete-run": {
        const nextRun = transitionRun(snapshot.run, {
          type: "run-completed",
          at,
          unfinishedStoryIds: [],
        });
        return {
          run: nextRun,
          stories: snapshot.stories,
          agents: snapshot.agents,
          events: [event("run-completed", "run", snapshot.run.id, at)],
        };
      }
    }
  }
}

test("a ready story advances through assignment, review, and merge to run completion", async () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      2_000,
      60_000,
    );
    fixture.repository.initializeRun({
      write: {
        ownerId: "controller-a",
        fencingToken: lease.fencingToken,
        now: 2_000,
      },
      idempotencyKey: "create-run-1",
      request: { command: "create-run" },
      run: activeRun(),
      stories: [readyStory()],
      agents: plannedAgents(),
      events: [event("run-created", "run", "run-1", 2_000)],
    });

    // A single monotonic counter drives every timestamp in this test — both
    // the orchestration loop's own actions and the externally-simulated
    // writer/reviewer activity between ticks — so the domain's
    // forward-time-only invariant is always satisfied regardless of which
    // actor produced the next transition.
    let clockValue = 2_100;
    const clock = (): number => {
      clockValue += 1;
      return clockValue;
    };
    const effects = new FakeEffects(clock);
    const loop = new OrchestrationLoop({
      repository: fixture.repository,
      effects,
      runId: "run-1",
      dependenciesByStory: new Map([["story-1", []]]),
      clock,
    });
    const write = () => ({
      ownerId: "controller-a",
      fencingToken: lease.fencingToken,
      now: clock(),
    });

    const assignTick = await loop.tick(write());
    assert.deepEqual(assignTick.actions, [
      { type: "assign-story", storyId: "story-1" },
    ]);
    assert.equal(assignTick.committed, true);
    const afterAssign = fixture.repository.loadSnapshot("run-1");
    assert.ok(afterAssign);
    assert.equal(afterAssign.stories[0]?.status, "assigned");
    assert.equal(afterAssign.stories[0].assignedAgentId, "agent-1");

    // The writer submits a candidate. That progression is driven by writer
    // activity elsewhere in the system, not by the orchestration loop, so it
    // is committed directly here to simulate that external actor.
    const working = transitionStory(afterAssign.stories[0], {
      type: "story-work-started",
      at: clock(),
    });
    const awaitingCandidate = transitionStory(working, {
      type: "candidate-requested",
      at: clock(),
      writerLeaseReleased: true,
    });
    const candidateAt = clock();
    const awaitingReview = transitionStory(awaitingCandidate, {
      type: "candidate-created",
      at: candidateAt,
      storyHead: "story-head-1",
      integrationHead: "integration-head-1",
    });
    fixture.repository.commitSnapshot({
      write: write(),
      runId: "run-1",
      expectedRevision: afterAssign.revision,
      idempotencyKey: "writer-submits-candidate",
      request: { command: "submit-candidate" },
      run: afterAssign.run,
      stories: [awaitingReview],
      agents: afterAssign.agents,
      events: [event("candidate-created", "story", "story-1", candidateAt)],
    });

    const reviewerTick = await loop.tick(write());
    assert.deepEqual(reviewerTick.actions, [
      { type: "assign-reviewer", storyId: "story-1" },
    ]);
    assert.equal(reviewerTick.committed, true);
    const afterReviewerAssigned = fixture.repository.loadSnapshot("run-1");
    assert.ok(afterReviewerAssigned);
    assert.equal(afterReviewerAssigned.stories[0]?.reviewerAgentId, "agent-2");

    // The reviewer approves. Again, external to the orchestration loop.
    const approvedAt = clock();
    const approved = transitionStory(afterReviewerAssigned.stories[0], {
      type: "review-approved",
      at: approvedAt,
      reviewerAgentId: "agent-2",
      storyHead: "story-head-1",
      integrationHead: "integration-head-1",
      checksPassed: true,
    });
    fixture.repository.commitSnapshot({
      write: write(),
      runId: "run-1",
      expectedRevision: afterReviewerAssigned.revision,
      idempotencyKey: "reviewer-approves",
      request: { command: "approve-review" },
      run: afterReviewerAssigned.run,
      stories: [approved],
      agents: afterReviewerAssigned.agents,
      events: [event("review-approved", "story", "story-1", approvedAt)],
    });

    const mergeTick = await loop.tick(write());
    assert.deepEqual(mergeTick.actions, [
      { type: "request-merge", storyId: "story-1" },
    ]);
    assert.equal(mergeTick.committed, true);
    const afterMerge = fixture.repository.loadSnapshot("run-1");
    assert.ok(afterMerge);
    assert.equal(afterMerge.stories[0]?.status, "merged");
    assert.equal(afterMerge.run.status, "active");

    const completionTick = await loop.tick(write());
    assert.deepEqual(completionTick.actions, [
      { type: "request-cleanup", storyId: "story-1" },
      { type: "complete-run" },
    ]);
    assert.equal(completionTick.committed, true);
    const afterCompletion = fixture.repository.loadSnapshot("run-1");
    assert.ok(afterCompletion);
    assert.equal(afterCompletion.run.status, "completed");

    const terminalTick = await loop.tick(write());
    assert.deepEqual(terminalTick, { actions: [], committed: false });
    assert.equal(
      fixture.repository.loadSnapshot("run-1")?.revision,
      afterCompletion.revision,
    );
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("committing the same orchestration tick twice replays instead of double-applying", async () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      2_000,
      60_000,
    );
    fixture.repository.initializeRun({
      write: {
        ownerId: "controller-a",
        fencingToken: lease.fencingToken,
        now: 2_000,
      },
      idempotencyKey: "create-run-1",
      request: { command: "create-run" },
      run: activeRun(),
      stories: [readyStory()],
      agents: plannedAgents(),
      events: [event("run-created", "run", "run-1", 2_000)],
    });

    let clockValue = 2_100;
    const clock = (): number => {
      clockValue += 1;
      return clockValue;
    };
    const effects = new FakeEffects(clock);
    const loop = new OrchestrationLoop({
      repository: fixture.repository,
      effects,
      runId: "run-1",
      dependenciesByStory: new Map([["story-1", []]]),
      clock,
    });
    const write = {
      ownerId: "controller-a",
      fencingToken: lease.fencingToken,
      now: 2_200,
    };

    const before = fixture.repository.loadSnapshot("run-1");
    assert.ok(before);
    const first = await loop.tick(write);
    assert.equal(first.committed, true);
    const afterFirstTick = fixture.repository.loadSnapshot("run-1");
    assert.ok(afterFirstTick);
    assert.equal(afterFirstTick.revision, before.revision + 1);
    assert.equal(effects.applied.length, 1);

    // Replay the exact commit the loop issued for that same starting
    // revision (as a retried/duplicate delivery of the same tick would).
    // The idempotency key ties it to that specific tick, so it must replay
    // the recorded result rather than reapply the state change again.
    const replay = fixture.repository.commitSnapshot({
      write,
      runId: "run-1",
      expectedRevision: before.revision,
      idempotencyKey: `orchestrate-r${String(before.revision)}`,
      request: { command: "orchestrate", revision: before.revision },
      run: afterFirstTick.run,
      stories: afterFirstTick.stories,
      agents: afterFirstTick.agents,
      // The replay short-circuits on the idempotency key before these
      // events would ever be applied, but the repository still validates
      // event-count shape up front, so a placeholder satisfies it.
      events: [event("story-assigned", "story", "story-1", 2_200)],
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, afterFirstTick.revision);

    const afterReplay = fixture.repository.loadSnapshot("run-1");
    assert.ok(afterReplay);
    assert.equal(afterReplay.revision, afterFirstTick.revision);
    assert.equal(effects.applied.length, 1);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a tick with no actionable stories is a no-op", async () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      2_000,
      60_000,
    );
    const blockedFromReady = readyStory();
    const blocked = transitionStory(
      transitionStory(blockedFromReady, {
        type: "story-assigned",
        at: 2_001,
        agentId: "agent-1",
      }),
      { type: "story-blocked", at: 2_002, reason: "sandbox unavailable" },
    );
    fixture.repository.initializeRun({
      write: {
        ownerId: "controller-a",
        fencingToken: lease.fencingToken,
        now: 2_000,
      },
      idempotencyKey: "create-run-1",
      request: { command: "create-run" },
      run: activeRun(),
      stories: [blocked],
      agents: plannedAgents(),
      events: [event("run-created", "run", "run-1", 2_000)],
    });

    let clockValue = 2_100;
    const clock = (): number => {
      clockValue += 1;
      return clockValue;
    };
    const effects = new FakeEffects(clock);
    const loop = new OrchestrationLoop({
      repository: fixture.repository,
      effects,
      runId: "run-1",
      dependenciesByStory: new Map([["story-1", []]]),
      clock,
    });

    const result = await loop.tick({
      ownerId: "controller-a",
      fencingToken: lease.fencingToken,
      now: 2_200,
    });
    assert.deepEqual(result, { actions: [], committed: false });
    assert.equal(effects.applied.length, 0);
    assert.equal(fixture.repository.loadSnapshot("run-1")?.revision, 1);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("tick is a no-op once the run reaches a terminal status", async () => {
  const fixture = createFixture();
  try {
    const lease = fixture.repository.acquireLease(
      "controller-a",
      2_000,
      60_000,
    );
    const cancelled = transitionRun(activeRun(), {
      type: "run-cancelled",
      at: 2_001,
      reason: "principal cancelled the run",
    });
    fixture.repository.initializeRun({
      write: {
        ownerId: "controller-a",
        fencingToken: lease.fencingToken,
        now: 2_000,
      },
      idempotencyKey: "create-run-1",
      request: { command: "create-run" },
      run: cancelled,
      stories: [readyStory()],
      agents: plannedAgents(),
      events: [event("run-created", "run", "run-1", 2_000)],
    });

    let clockValue = 2_100;
    const clock = (): number => {
      clockValue += 1;
      return clockValue;
    };
    const effects = new FakeEffects(clock);
    const loop = new OrchestrationLoop({
      repository: fixture.repository,
      effects,
      runId: "run-1",
      dependenciesByStory: new Map([["story-1", []]]),
      clock,
    });

    const result = await loop.tick({
      ownerId: "controller-a",
      fencingToken: lease.fencingToken,
      now: 2_200,
    });
    assert.deepEqual(result, { actions: [], committed: false });
    assert.equal(effects.applied.length, 0);
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an unknown run id is a no-op", async () => {
  const fixture = createFixture();
  try {
    let clockValue = 2_100;
    const clock = (): number => {
      clockValue += 1;
      return clockValue;
    };
    const effects = new FakeEffects(clock);
    const loop = new OrchestrationLoop({
      repository: fixture.repository,
      effects,
      runId: "missing-run",
      dependenciesByStory: new Map(),
      clock,
    });

    const result = await loop.tick({
      ownerId: "controller-a",
      fencingToken: 1,
      now: 2_200,
    });
    assert.deepEqual(result, { actions: [], committed: false });
  } finally {
    fixture.repository.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
