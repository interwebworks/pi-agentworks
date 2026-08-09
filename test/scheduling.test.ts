import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCapacity,
  countOccupiedAgentSlots,
  occupiesAgentCapacity,
  scheduleStories,
  storyConcurrencyCap,
  SchedulingError,
  type SchedulableStory,
} from "../src/domain/scheduling.ts";
import type { AgentStatus } from "../src/domain/controller-state.ts";

function story(
  id: string,
  status: SchedulableStory["status"],
  dependencies: readonly string[] = [],
): SchedulableStory {
  return { id, status, dependencies };
}

test("starts only pending stories whose dependencies are all done", () => {
  const decision = scheduleStories(
    [
      story("a", "done"),
      story("b", "pending", ["a"]),
      story("c", "pending", ["b"]),
    ],
    8,
  );
  assert.deepEqual(decision.startable, ["b"]);
  assert.deepEqual(decision.blocked, []);
});

test("caps concurrent starts by the remaining budget", () => {
  const decision = scheduleStories(
    [
      story("r", "running"),
      story("a", "pending"),
      story("b", "pending"),
      story("c", "pending"),
    ],
    2,
  );
  assert.equal(decision.runningCount, 1);
  assert.equal(decision.capacity, 1);
  assert.deepEqual(decision.startable, ["a"]);
});

test("blocks pending stories whose dependency failed", () => {
  const decision = scheduleStories(
    [story("a", "failed"), story("b", "pending", ["a"])],
    8,
  );
  assert.deepEqual(decision.startable, []);
  assert.deepEqual(decision.blocked, ["b"]);
});

test("reports deadlock when nothing runs and nothing can start", () => {
  const decision = scheduleStories(
    [story("a", "failed"), story("b", "pending", ["a"])],
    8,
  );
  assert.equal(decision.deadlocked, true);
});

test("is not deadlocked while work is still running", () => {
  const decision = scheduleStories(
    [story("a", "running"), story("b", "pending", ["a"])],
    8,
  );
  assert.equal(decision.deadlocked, false);
  assert.deepEqual(decision.startable, []);
});

test("preserves input (dependency) order among startable stories", () => {
  const decision = scheduleStories(
    [story("a", "pending"), story("b", "pending"), story("c", "pending")],
    2,
  );
  assert.deepEqual(decision.startable, ["a", "b"]);
});

test("rejects unknown dependencies, duplicates, and bad caps", () => {
  assert.throws(
    () => scheduleStories([story("b", "pending", ["ghost"])], 4),
    /unknown story ghost/u,
  );
  assert.throws(
    () => scheduleStories([story("a", "pending"), story("a", "done")], 4),
    /duplicate story id: a/u,
  );
  assert.throws(
    () => scheduleStories([story("a", "pending")], 0),
    (error: unknown) => {
      assert.ok(error instanceof SchedulingError);
      return true;
    },
  );
});

test("concurrency cap leaves room for the PM and a reviewer", () => {
  assert.equal(storyConcurrencyCap("LOW"), 2); // 4 - 2
  assert.equal(storyConcurrencyCap("NORMAL"), 6); // 8 - 2
  assert.equal(storyConcurrencyCap("HIGH"), 14); // 16 - 2
});

test("all unclosed agent states occupy the one run-level capacity", () => {
  const statuses: readonly AgentStatus[] = [
    "planned",
    "launching",
    "idle",
    "working",
    "waiting",
    "blocked",
    "reviewing",
    "disconnected",
    "completed",
    "failed",
    "closed",
  ];
  assert.deepEqual(statuses.filter(occupiesAgentCapacity), [
    "planned",
    "launching",
    "idle",
    "working",
    "waiting",
    "blocked",
    "reviewing",
    "disconnected",
    "completed",
    "failed",
  ]);
  assert.equal(
    countOccupiedAgentSlots(statuses.map((status) => ({ status }))),
    10,
  );
  assert.deepEqual(agentCapacity("LOW", 4), {
    limit: 4,
    occupied: 4,
    available: 0,
  });
});

test("capacity is released only after the agent is closed", () => {
  for (const status of [
    "blocked",
    "disconnected",
    "completed",
    "failed",
  ] as const) {
    assert.equal(occupiesAgentCapacity(status), true);
  }
  assert.equal(occupiesAgentCapacity("closed"), false);
  assert.throws(() => agentCapacity("LOW", -1), SchedulingError);
});
