import assert from "node:assert/strict";
import test from "node:test";
import { InvalidTaskSpecificationError } from "../src/domain/task-specification.ts";
import {
  buildAssignment,
  StoryPlanError,
  validateAndOrderStories,
  type AssignableRole,
  type UserStory,
} from "../src/domain/story-planning.ts";

function story(overrides: Partial<UserStory> & { id: string }): UserStory {
  return {
    title: `Story ${overrides.id}`,
    narrative: "As a user, I want a thing, so that I benefit.",
    objective: "Deliver the thing.",
    taskKinds: ["software"],
    writable: true,
    dependencies: [],
    scope: { included: ["the thing"], excluded: ["everything else"] },
    technologyChoices: ["typescript"],
    constraints: ["stay in scope"],
    deliverables: ["the thing"],
    acceptanceCriteria: ["the thing works"],
    validation: [{ command: "npm test", expected: "exit 0" }],
    escalationConditions: ["blocked over 30 minutes"],
    ...overrides,
  };
}

const writerRole: AssignableRole = {
  runtimeId: "software-development/backend-developer",
  writePolicy: "story-writer",
  tools: ["read", "write", "edit"],
};

test("orders stories by dependency, breaking ties on input order", () => {
  const ordered = validateAndOrderStories([
    story({ id: "c", dependencies: ["a", "b"] }),
    story({ id: "a" }),
    story({ id: "b", dependencies: ["a"] }),
  ]);
  assert.deepEqual(
    ordered.map((s) => s.id),
    ["a", "b", "c"],
  );
});

test("rejects duplicate story ids", () => {
  assert.throws(
    () => validateAndOrderStories([story({ id: "a" }), story({ id: "a" })]),
    /duplicate story id: a/u,
  );
});

test("rejects a dependency on an unknown story", () => {
  assert.throws(
    () =>
      validateAndOrderStories([story({ id: "a", dependencies: ["ghost"] })]),
    /depends on unknown story ghost/u,
  );
});

test("rejects a dependency cycle", () => {
  assert.throws(
    () =>
      validateAndOrderStories([
        story({ id: "a", dependencies: ["b"] }),
        story({ id: "b", dependencies: ["a"] }),
      ]),
    (error: unknown) => {
      assert.ok(error instanceof StoryPlanError);
      assert.match(error.message, /cycle/u);
      return true;
    },
  );
});

test("rejects a plan with no writable story", () => {
  assert.throws(
    () => validateAndOrderStories([story({ id: "a", writable: false })]),
    /at least one writable story/u,
  );
});

test("rejects an empty plan", () => {
  assert.throws(() => validateAndOrderStories([]), /at least one story/u);
});

test("builds a valid assignment from a story, role, and its existing worktree", () => {
  const spec = buildAssignment({
    runId: "run-1",
    story: story({ id: "backend" }),
    role: writerRole,
    agentId: "agent-1",
    repositoryRoot: "/repo",
    branchName: "agentworks/run-1/stories/backend",
    worktreePath: "/worktrees/run-1/backend",
    baseBranch: "agentworks/run-1/integration",
  });

  assert.equal(spec.assignedRole, "software-development/backend-developer");
  assert.equal(spec.branchName, "agentworks/run-1/stories/backend");
  assert.equal(spec.worktreePath, "/worktrees/run-1/backend");
  assert.notEqual(spec.branchName, spec.baseBranch);
  assert.equal(spec.writePolicy, "story-writer");
});

test("rejects an assignment whose worktree is inside the repository", () => {
  assert.throws(
    () =>
      buildAssignment({
        runId: "run-1",
        story: story({ id: "backend" }),
        role: writerRole,
        agentId: "agent-1",
        repositoryRoot: "/repo",
        branchName: "agentworks/run-1/stories/backend",
        worktreePath: "/repo/worktrees/run-1/backend",
        baseBranch: "main",
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTaskSpecificationError);
      assert.match(error.message, /outside the original repository/u);
      return true;
    },
  );
});

test("rejects a read-only role that carries write tools", () => {
  assert.throws(
    () =>
      buildAssignment({
        runId: "run-1",
        story: story({ id: "review" }),
        role: {
          runtimeId: "general-delivery/reviewer",
          writePolicy: "read-only",
          tools: ["read", "write"],
        },
        agentId: "agent-2",
        repositoryRoot: "/repo",
        branchName: "agentworks/run-1/stories/review",
        worktreePath: "/worktrees/run-1/review",
        baseBranch: "main",
      }),
    /read-only assignments cannot include write or edit tools/u,
  );
});
