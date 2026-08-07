import assert from "node:assert/strict";
import test from "node:test";
import {
  planOrchestration,
  reserveAgentLaunchCapacity,
  type OrchestrationAction,
  type OrchestrationStory,
} from "../src/domain/orchestration.ts";

function story(
  overrides: Partial<OrchestrationStory> & { id: string },
): OrchestrationStory {
  return {
    status: "ready",
    dependencies: [],
    reviewerAssigned: false,
    ...overrides,
  };
}

test("assigns ready stories whose dependencies are merged", () => {
  const actions = planOrchestration(
    [
      story({ id: "a", status: "merged" }),
      story({ id: "b", status: "ready", dependencies: ["a"] }),
      story({ id: "c", status: "ready", dependencies: ["b"] }),
    ],
    "NORMAL",
  );
  // a merged -> cleanup; b assignable (dep merged); c waits on b.
  assert.deepEqual(actions, [
    { type: "request-cleanup", storyId: "a" },
    { type: "assign-story", storyId: "b" },
  ]);
});

test("requests a merge for approved stories and cleanup for merged ones", () => {
  const actions = planOrchestration(
    [
      story({ id: "a", status: "approved" }),
      story({ id: "b", status: "merged" }),
    ],
    "NORMAL",
  );
  assert.ok(
    actions.some((a) => a.type === "request-cleanup" && a.storyId === "b"),
  );
  assert.ok(
    actions.some((a) => a.type === "request-merge" && a.storyId === "a"),
  );
});

test("assigns a reviewer only when none is assigned", () => {
  const actions = planOrchestration(
    [
      story({ id: "a", status: "awaiting-review", reviewerAssigned: false }),
      story({ id: "b", status: "awaiting-review", reviewerAssigned: true }),
    ],
    "NORMAL",
  );
  const reviewerActions = actions.filter((a) => a.type === "assign-reviewer");
  assert.deepEqual(reviewerActions, [
    { type: "assign-reviewer", storyId: "a" },
  ]);
});

test("respects the mode concurrency cap when assigning new stories", () => {
  const stories = Array.from({ length: 5 }, (_unused, index) =>
    story({ id: `s${String(index)}`, status: "ready" }),
  );
  const low = planOrchestration(stories, "LOW"); // cap 2
  assert.equal(low.filter((a) => a.type === "assign-story").length, 2);
});

test("does not schedule new work behind an in-flight dependency", () => {
  const actions = planOrchestration(
    [
      story({ id: "a", status: "working" }),
      story({ id: "b", status: "ready", dependencies: ["a"] }),
    ],
    "NORMAL",
  );
  assert.deepEqual(
    actions.filter((a) => a.type === "assign-story"),
    [],
  );
});

test("completes the run once every story is merged", () => {
  const actions = planOrchestration(
    [
      story({ id: "a", status: "merged" }),
      story({ id: "b", status: "merged" }),
    ],
    "NORMAL",
  );
  assert.ok(actions.some((a) => a.type === "complete-run"));
});

test("an empty run produces no actions", () => {
  assert.deepEqual(planOrchestration([], "HIGH"), []);
});

test("advisors and reviewers reserve the same global slots as writers and managers", () => {
  const candidates: readonly OrchestrationAction[] = [
    { type: "assign-project-manager", storyId: "a" },
    { type: "assign-advisor", storyId: "a" },
    { type: "assign-reviewer", storyId: "a" },
    { type: "assign-story", storyId: "b" },
    { type: "request-merge", storyId: "c" },
  ];
  const decision = reserveAgentLaunchCapacity(candidates, "LOW", 2);
  assert.deepEqual(decision, {
    actions: [
      { type: "assign-project-manager", storyId: "a" },
      { type: "assign-advisor", storyId: "a" },
      { type: "request-merge", storyId: "c" },
    ],
    occupied: 2,
    reserved: 2,
    remaining: 0,
  });
});

test("reviewers advance before new multi-story work at the global boundary", () => {
  const actions = planOrchestration(
    [
      story({ id: "review-a", status: "awaiting-review" }),
      story({ id: "review-b", status: "awaiting-review" }),
      story({ id: "write-a", status: "ready" }),
      story({ id: "write-b", status: "ready" }),
    ],
    "LOW",
    3,
  );
  assert.deepEqual(actions, [{ type: "assign-reviewer", storyId: "review-a" }]);
});

test("multi-story starts retain the story cap and also honor remaining agent capacity", () => {
  const stories = Array.from({ length: 10 }, (_unused, index) =>
    story({ id: `story-${String(index)}` }),
  );
  assert.equal(
    planOrchestration(stories, "NORMAL", 6).filter(
      (action) => action.type === "assign-story",
    ).length,
    2,
  );
  assert.equal(
    planOrchestration(stories, "NORMAL", 8).filter(
      (action) => action.type === "assign-story",
    ).length,
    0,
  );
});
