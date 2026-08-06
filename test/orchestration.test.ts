import assert from "node:assert/strict";
import test from "node:test";
import {
  planOrchestration,
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
