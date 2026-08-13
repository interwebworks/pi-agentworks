import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidInitialStoryPlanError,
  parseInitialStoryPlan,
} from "../src/domain/initial-story-plan.ts";

function story(id: string, dependencies: string[] = []) {
  return {
    id,
    title: `Deliver ${id}`,
    narrative:
      "As a user, I want this delivered so that I receive the requested capability.",
    objective: `Implement ${id} completely.`,
    taskKinds: ["software-development"],
    writable: true as const,
    dependencies,
    scope: { included: [id], excluded: ["unrelated changes"] },
    technologyChoices: ["existing repository stack"],
    constraints: ["preserve existing behavior outside the story scope"],
    deliverables: [`implemented ${id}`],
    acceptanceCriteria: [`${id} behaves as specified`],
    validation: [{ command: "npm test", expected: "passes" }],
    escalationConditions: ["required product behavior is ambiguous"],
  };
}

test("validates and dependency-orders a parent-model initial plan", () => {
  const plan = parseInitialStoryPlan({
    stories: [story("delivery", ["foundation"]), story("foundation")],
  });

  assert.deepEqual(
    plan.stories.map((candidate) => candidate.id),
    ["foundation", "delivery"],
  );
});

test("rejects an incomplete or non-deliverable parent-model plan", () => {
  assert.throws(
    () =>
      parseInitialStoryPlan({
        stories: [{ ...story("not-writable"), writable: false }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidInitialStoryPlanError);
      assert.match(error.message, /writable/u);
      return true;
    },
  );
});
