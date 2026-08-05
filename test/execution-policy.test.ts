import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentLaunchDeniedError,
  assessCleanupEligibility,
  assessMergeEligibility,
  assertAgentLaunchPermitted,
  type MergeEligibilityRequest,
  type SandboxEvidence,
} from "../src/domain/execution-policy.ts";
import type { TaskSpecification } from "../src/domain/task-specification.ts";

const task = {
  writePolicy: "story-writer",
} as TaskSpecification;

const secureSandbox: SandboxEvidence = {
  kind: "bubblewrap",
  filesystemBoundary: "kernel-enforced",
  rootReadOnly: true,
  assignedWorktreeWritable: true,
  gitMetadataReadOnly: true,
  environmentSanitized: true,
  networkIsolated: true,
};

test("permits a child only with the complete production sandbox boundary", () => {
  assert.doesNotThrow(() =>
    assertAgentLaunchPermitted({
      complexity: "NORMAL",
      task,
      sandbox: secureSandbox,
      roleRequiresNetwork: false,
    }),
  );
});

test("HIGH mode cannot bypass a missing sandbox", () => {
  assert.throws(
    () =>
      assertAgentLaunchPermitted({
        complexity: "HIGH",
        task,
        sandbox: undefined,
        roleRequiresNetwork: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AgentLaunchDeniedError);
      assert.match(error.message, /production sandbox is required/u);
      return true;
    },
  );
});

test("denies writable Git metadata to child agents", () => {
  assert.throws(
    () =>
      assertAgentLaunchPermitted({
        complexity: "LOW",
        task,
        sandbox: { ...secureSandbox, gitMetadataReadOnly: false },
        roleRequiresNetwork: false,
      }),
    /Git metadata must be read-only/u,
  );
});

test("denies network access to roles without an approved requirement", () => {
  assert.throws(
    () =>
      assertAgentLaunchPermitted({
        complexity: "NORMAL",
        task,
        sandbox: { ...secureSandbox, networkIsolated: false },
        roleRequiresNetwork: false,
      }),
    /must have network isolation/u,
  );
});

function eligibleMerge(
  overrides: Partial<MergeEligibilityRequest> = {},
): MergeEligibilityRequest {
  return {
    requesterRole: "project-manager",
    writerAgentId: "writer-1",
    storyHead: "story-head",
    integrationHead: "integration-head",
    storyWorktreeClean: true,
    targetIsRunIntegrationBranch: true,
    targetIsDefaultOrProtected: false,
    protectedTargetUserApproval: false,
    controllerLeaseCurrent: true,
    expectedRevisionMatches: true,
    review: {
      reviewerAgentId: "reviewer-1",
      verdict: "approved",
      reviewedStoryHead: "story-head",
      reviewedIntegrationHead: "integration-head",
      requiredChecksPassed: true,
    },
    ...overrides,
  };
}

test("allows controller integration only for exact approved evidence", () => {
  assert.deepEqual(assessMergeEligibility(eligibleMerge()), {
    allowed: true,
    reasons: [],
  });
});

test("invalidates review when story or integration HEAD changes", () => {
  const decision = assessMergeEligibility(
    eligibleMerge({
      storyHead: "changed-story",
      integrationHead: "changed-integration",
    }),
  );

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons, [
    "the story HEAD changed after review",
    "the integration HEAD changed after review",
  ]);
});

test("denies self-review by the writer", () => {
  const decision = assessMergeEligibility(
    eligibleMerge({
      review: {
        reviewerAgentId: "writer-1",
        verdict: "approved",
        reviewedStoryHead: "story-head",
        reviewedIntegrationHead: "integration-head",
        requiredChecksPassed: true,
      },
    }),
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join("\n"), /cannot independently review/u);
});

test("denies merge requests from worker agents", () => {
  const decision = assessMergeEligibility(
    eligibleMerge({ requesterRole: "backend-developer" }),
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join("\n"), /only the run Project Manager/u);
});

test("denies protected target integration without explicit user approval", () => {
  const decision = assessMergeEligibility(
    eligibleMerge({
      targetIsRunIntegrationBranch: false,
      targetIsDefaultOrProtected: true,
      protectedTargetUserApproval: false,
    }),
  );

  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join("\n"), /explicit user approval/u);
});

test("denies duplicate or stale merge execution", () => {
  const decision = assessMergeEligibility(
    eligibleMerge({
      controllerLeaseCurrent: false,
      expectedRevisionMatches: false,
    }),
  );

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.reasons.slice(0, 2), [
    "the controller writer lease is stale",
    "the controller revision changed",
  ]);
});

test("cleanup requires cleanliness, ancestry proof, ownership, and released writer lease", () => {
  const denied = assessCleanupEligibility({
    controllerLeaseCurrent: true,
    expectedRevisionMatches: true,
    worktreeClean: false,
    storyMergedIntoIntegration: false,
    writerLeaseReleased: false,
    agentClosed: false,
    worktreeBelongsToRun: false,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reasons.length, 5);

  const allowed = assessCleanupEligibility({
    controllerLeaseCurrent: true,
    expectedRevisionMatches: true,
    worktreeClean: true,
    storyMergedIntoIntegration: true,
    writerLeaseReleased: true,
    agentClosed: true,
    worktreeBelongsToRun: true,
  });
  assert.deepEqual(allowed, { allowed: true, reasons: [] });
});
