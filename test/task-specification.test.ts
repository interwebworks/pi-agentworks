import assert from "node:assert/strict";
import test from "node:test";
import {
  InvalidTaskSpecificationError,
  parseTaskSpecification,
  type TaskSpecification,
} from "../src/domain/task-specification.ts";

function validTask(
  overrides: Partial<TaskSpecification> = {},
): TaskSpecification {
  return {
    schemaVersion: 1,
    runId: "run-001",
    storyId: "story-001",
    taskId: "task-001",
    title: "Implement session validation",
    userStory:
      "As an account owner, I can validate my active session before viewing private data.",
    objective:
      "Add the approved session validation behavior without changing unrelated authentication flows.",
    assignedAgentId: "backend-developer-1",
    assignedRole: "backend-developer",
    repositoryRoot: "/tmp/project",
    baseBranch: "agentworks/run-001/integration",
    branchName: "agentworks/run-001/story-001",
    worktreePath: "/tmp/agentworks-worktrees/run-001/story-001",
    scope: {
      included: ["Session validation endpoint and focused tests"],
      excluded: ["Authentication provider migration"],
    },
    technologyChoices: [
      "Use the repository's existing TypeScript and test framework",
    ],
    constraints: ["Preserve the public error response contract"],
    dependencies: [],
    deliverables: ["Implementation and regression tests"],
    acceptanceCriteria: [
      "Invalid sessions receive the existing unauthorized response",
    ],
    validation: [
      {
        command: "npm test -- session",
        expected: "Command exits successfully",
      },
    ],
    escalationConditions: [
      "Stop if the existing public error contract is ambiguous",
    ],
    allowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    writePolicy: "story-writer",
    ...overrides,
  };
}

test("accepts a fully prepared isolated task specification", () => {
  const task = validTask();
  const parsed = parseTaskSpecification(task);

  assert.equal(parsed.taskId, task.taskId);
  assert.equal(parsed.worktreePath, task.worktreePath);
  assert.equal(Object.isFrozen(parsed), true);
});

test("rejects an agent worktree inside the original checkout", () => {
  assert.throws(
    () =>
      parseTaskSpecification(
        validTask({ worktreePath: "/tmp/project/.worktrees/story-001" }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTaskSpecificationError);
      assert.match(error.message, /outside the original repository checkout/u);
      return true;
    },
  );
});

test("rejects assignments that omit required execution detail", () => {
  assert.throws(
    () => parseTaskSpecification({ ...validTask(), acceptanceCriteria: [] }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidTaskSpecificationError);
      assert.match(error.message, /acceptanceCriteria/u);
      return true;
    },
  );
});

test("rejects unsafe branch names", () => {
  assert.throws(
    () =>
      parseTaskSpecification(
        validTask({ branchName: "agentworks/run 001/story" }),
      ),
    /safe Git branch name/u,
  );
});

test("rejects write tools for read-only roles", () => {
  assert.throws(
    () =>
      parseTaskSpecification(
        validTask({
          writePolicy: "read-only",
          allowedTools: ["read", "grep", "edit"],
        }),
      ),
    /read-only assignments cannot include write or edit tools/u,
  );
});

test("requires a writing tool for write-capable roles", () => {
  assert.throws(
    () =>
      parseTaskSpecification(
        validTask({ allowedTools: ["read", "grep", "bash"] }),
      ),
    /write-capable assignments must include write or edit/u,
  );
});

test("rejects unexpected fields instead of silently widening task scope", () => {
  assert.throws(
    () =>
      parseTaskSpecification({
        ...validTask(),
        surpriseInstruction: "Rewrite everything",
      }),
    /surpriseInstruction/u,
  );
});
