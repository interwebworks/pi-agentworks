import type { ComplexityMode } from "./complexity.ts";
import type { TaskSpecification } from "./task-specification.ts";

export type ProductionSandboxKind = "bubblewrap";

export interface SandboxEvidence {
  readonly kind: ProductionSandboxKind;
  readonly filesystemBoundary: "kernel-enforced" | "advisory";
  readonly rootReadOnly: boolean;
  readonly assignedWorktreeWritable: boolean;
  readonly gitMetadataReadOnly: boolean;
  readonly environmentSanitized: boolean;
  readonly networkIsolated: boolean;
}

export interface AgentLaunchRequest {
  readonly complexity: ComplexityMode;
  readonly task: TaskSpecification;
  readonly sandbox: SandboxEvidence | undefined;
  readonly roleRequiresNetwork: boolean;
}

export class AgentLaunchDeniedError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Agentworks denied the agent launch:\n- ${reasons.join("\n- ")}`);
    this.name = "AgentLaunchDeniedError";
    this.reasons = reasons;
  }
}

export function assertAgentLaunchPermitted(request: AgentLaunchRequest): void {
  const reasons: string[] = [];
  const { sandbox } = request;

  if (sandbox === undefined) {
    reasons.push("a production sandbox is required");
  } else {
    if (sandbox.filesystemBoundary !== "kernel-enforced") {
      reasons.push("filesystem isolation must be kernel-enforced");
    }
    if (!sandbox.rootReadOnly) {
      reasons.push("the host root must be mounted read-only");
    }
    if (!sandbox.assignedWorktreeWritable) {
      reasons.push("the assigned worktree must be the project write boundary");
    }
    if (!sandbox.gitMetadataReadOnly) {
      reasons.push("Git metadata must be read-only to child agents");
    }
    if (!sandbox.environmentSanitized) {
      reasons.push("the child environment must use an explicit allowlist");
    }
    if (!request.roleRequiresNetwork && !sandbox.networkIsolated) {
      reasons.push(
        "roles without an approved network requirement must have network isolation",
      );
    }
  }

  if (reasons.length > 0) {
    throw new AgentLaunchDeniedError(reasons);
  }
}

export type ReviewVerdict = "approved" | "changes-requested";

export interface ReviewEvidence {
  readonly reviewerAgentId: string;
  readonly verdict: ReviewVerdict;
  readonly reviewedStoryHead: string;
  readonly reviewedIntegrationHead: string;
  readonly requiredChecksPassed: boolean;
}

export interface MergeEligibilityRequest {
  readonly requesterRole: string;
  readonly writerAgentId: string;
  readonly storyHead: string;
  readonly integrationHead: string;
  readonly storyWorktreeClean: boolean;
  readonly targetIsRunIntegrationBranch: boolean;
  readonly targetIsDefaultOrProtected: boolean;
  readonly protectedTargetUserApproval: boolean;
  readonly controllerLeaseCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
  readonly review: ReviewEvidence | undefined;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reasons: readonly string[];
}

export function assessMergeEligibility(
  request: MergeEligibilityRequest,
): PolicyDecision {
  const reasons: string[] = [];

  if (request.requesterRole !== "project-manager") {
    reasons.push("only the run Project Manager may request integration");
  }
  if (!request.controllerLeaseCurrent) {
    reasons.push("the controller writer lease is stale");
  }
  if (!request.expectedRevisionMatches) {
    reasons.push("the controller revision changed");
  }
  if (!request.storyWorktreeClean) {
    reasons.push("the story worktree is not clean");
  }
  if (!request.targetIsRunIntegrationBranch) {
    reasons.push("the target is not the run integration branch");
  }
  if (
    request.targetIsDefaultOrProtected &&
    !request.protectedTargetUserApproval
  ) {
    reasons.push("default or protected targets require explicit user approval");
  }

  const { review } = request;
  if (review === undefined) {
    reasons.push("independent review evidence is required");
  } else {
    if (review.reviewerAgentId === request.writerAgentId) {
      reasons.push("the writer cannot independently review their own story");
    }
    if (review.verdict !== "approved") {
      reasons.push("the reviewer did not approve the story");
    }
    if (!review.requiredChecksPassed) {
      reasons.push("required validation checks did not pass");
    }
    if (review.reviewedStoryHead !== request.storyHead) {
      reasons.push("the story HEAD changed after review");
    }
    if (review.reviewedIntegrationHead !== request.integrationHead) {
      reasons.push("the integration HEAD changed after review");
    }
  }

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}

export interface CleanupEligibilityRequest {
  readonly controllerLeaseCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
  readonly worktreeClean: boolean;
  readonly storyMergedIntoIntegration: boolean;
  readonly writerLeaseReleased: boolean;
  readonly agentClosed: boolean;
  readonly worktreeBelongsToRun: boolean;
}

export function assessCleanupEligibility(
  request: CleanupEligibilityRequest,
): PolicyDecision {
  const reasons: string[] = [];

  if (!request.controllerLeaseCurrent) {
    reasons.push("the controller writer lease is stale");
  }
  if (!request.expectedRevisionMatches) {
    reasons.push("the controller revision changed");
  }
  if (!request.worktreeClean) {
    reasons.push("the worktree is not clean");
  }
  if (!request.storyMergedIntoIntegration) {
    reasons.push("merge ancestry proof is missing");
  }
  if (!request.writerLeaseReleased) {
    reasons.push("the writer lease is still active");
  }
  if (!request.agentClosed) {
    reasons.push("the writer agent is not closed");
  }
  if (!request.worktreeBelongsToRun) {
    reasons.push("the worktree does not belong to this run");
  }

  return Object.freeze({
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}
