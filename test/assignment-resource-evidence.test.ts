import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunState,
  createStoryState,
} from "../src/domain/controller-state.ts";
import {
  assertAssignmentInfrastructureEvidence,
  AssignmentInfrastructureEvidenceError,
  type AssignmentInfrastructureEvidence,
} from "../src/application/launch/assignment-resource-evidence.ts";

function fixture(): {
  readonly run: ReturnType<typeof createRunState>;
  readonly story: ReturnType<typeof createStoryState>;
  readonly evidence: AssignmentInfrastructureEvidence;
} {
  const run = createRunState({
    id: "run-1",
    title: "Ship",
    complexity: "HIGH",
    repositoryRoot: "/repo",
    originalCheckout: "/repo",
    baseBranch: "main",
    integrationBranch: "agentworks/run-1/integration",
    integrationWorktree: "/worktree/integration",
    createdAt: 1,
  });
  const story = createStoryState({
    id: "story-1",
    runId: run.id,
    title: "Story",
    branchName: "agentworks/run-1/story-1",
    worktreePath: "/worktree/story-1",
    createdAt: 1,
  });
  return {
    run,
    story,
    evidence: {
      git: {
        commonGitDirectory: "/repo/.git",
        baseBranch: run.integrationBranch,
        expectedIntegrationHead: "a".repeat(40),
        integrationBranch: run.integrationBranch,
        storyBranch: story.branchName,
        expectedStoryHead: "b".repeat(40),
        worktreePath: story.worktreePath,
      },
      herdr: {
        paneId: "pane-1",
        cwd: story.worktreePath,
        tokens: { aw_kind: "agent", aw_run: run.id, aw_agent: "agent-1" },
      },
      session: {
        sessionPath: "/session",
        configPath: "/session/config",
        controllerChildAuthToken: "A".repeat(43),
      },
      controllerSocketPath: "/runtime/controller.sock",
      runtimePath: "/runtime",
      controllerFenceCurrent: true,
      expectedRevisionMatches: true,
    },
  };
}

test("infrastructure evidence validates matching Git, Herdr, session, and fence identities", () => {
  const { run, story, evidence } = fixture();
  assert.doesNotThrow(() =>
    assertAssignmentInfrastructureEvidence(evidence, run, story, "agent-1"),
  );
});

test("infrastructure evidence rejects pane ownership drift", () => {
  const { run, story, evidence } = fixture();
  assert.throws(
    () =>
      assertAssignmentInfrastructureEvidence(
        {
          ...evidence,
          herdr: {
            ...evidence.herdr,
            tokens: { ...evidence.herdr.tokens, aw_agent: "agent-2" },
          },
        },
        run,
        story,
        "agent-1",
      ),
    (error: unknown) =>
      error instanceof AssignmentInfrastructureEvidenceError &&
      error.message.includes("aw_agent"),
  );
});
