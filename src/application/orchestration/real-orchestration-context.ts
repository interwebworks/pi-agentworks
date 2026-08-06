import { assessBranchProtection } from "../../domain/branch-protection.ts";
import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type {
  ControllerRepository,
  ControllerSnapshot,
} from "../ports/controller-repository.ts";
import type { GitRepositoryInspector } from "../ports/git-repository-inspector.ts";
import type {
  CleanupFacts,
  MergeFacts,
  OrchestrationContext,
} from "../ports/orchestration-context.ts";

export class RealOrchestrationContextError extends Error {
  constructor(message: string) {
    super(`Agentworks orchestration context failed: ${message}`);
    this.name = "RealOrchestrationContextError";
  }
}

export interface RealOrchestrationContextDependencies {
  readonly repository: ControllerRepository;
  readonly gitInspector: GitRepositoryInspector;
  /**
   * Whether the user has explicitly approved merging into a default or
   * protected branch for this run. No approval mechanism is modeled yet
   * (that is a TUI/parent-extension concern), so this defaults to always
   * denying — the safe default — until one is wired in.
   */
  readonly protectedTargetApproved?: (run: RunState) => boolean;
}

/**
 * The real `OrchestrationContext`: computes the runtime facts the merge and
 * cleanup Git operations need that are not already durable on `StoryState`.
 *
 * Two facts are structural invariants of the story/run state machines rather
 * than live reads, and are asserted `true` on that basis (see inline
 * comments): `requiredChecksPassed` and `controllerLeaseCurrent` /
 * `expectedRevisionMatches`. The latter two are also enforced transactionally
 * by `ControllerRepository.commitSnapshot`'s fencing and optimistic-revision
 * check — a stale lease or revision fails the commit regardless of what this
 * context reports, so this is an attestation, not the sole enforcement.
 *
 * Operation identifiers are derived deterministically from
 * `story.candidateStoryHead`, which is stable from the moment a candidate is
 * created through cleanup (only `status`, `mergeHead`, and `updatedAt` change
 * across those transitions) — so the same story always produces the same
 * merge operation id whether asked before or after the merge, letting cleanup
 * recompute `mergeOperationId`/`mergeSubject` without separate bookkeeping.
 */
export class RealOrchestrationContext implements OrchestrationContext {
  readonly #repository: ControllerRepository;
  readonly #gitInspector: GitRepositoryInspector;
  readonly #protectedTargetApproved: (run: RunState) => boolean;

  constructor(dependencies: RealOrchestrationContextDependencies) {
    this.#repository = dependencies.repository;
    this.#gitInspector = dependencies.gitInspector;
    this.#protectedTargetApproved =
      dependencies.protectedTargetApproved ?? (() => false);
  }

  #candidateStoryHead(story: StoryState): string {
    if (story.candidateStoryHead === null) {
      throw new RealOrchestrationContextError(
        `story ${story.id} has no candidate commit yet`,
      );
    }
    return story.candidateStoryHead;
  }

  #mergeOperationId(story: StoryState): string {
    return `merge-${story.id}-${this.#candidateStoryHead(story)}`;
  }

  #mergeSubject(story: StoryState): string {
    return `Merge ${story.title} (${story.id})`;
  }

  #writerLeaseReleased(run: RunState, story: StoryState): boolean {
    const lease = this.#repository.readWriterLease(run.id, story.id);
    return (lease?.ownerAgentId ?? null) === null;
  }

  mergeFacts(story: StoryState, snapshot: ControllerSnapshot): MergeFacts {
    const run = snapshot.run;
    const inspection = this.#gitInspector.inspect(run.originalCheckout);
    const protection = assessBranchProtection(
      inspection,
      run.integrationBranch,
    );

    return Object.freeze({
      operationId: this.#mergeOperationId(story),
      requesterRole: "project-manager",
      subject: this.#mergeSubject(story),
      // Structural invariant: `review-approved` only reaches "approved"
      // status when its own `checksPassed` transition input was true.
      requiredChecksPassed: true,
      writerLeaseReleased: this.#writerLeaseReleased(run, story),
      // Structural: this call happens inside a fenced orchestration tick;
      // `commitSnapshot` re-validates the fence and revision transactionally
      // when the loop persists the result of this action.
      controllerLeaseCurrent: true,
      expectedRevisionMatches: true,
      targetIsDefaultOrProtected: protection.protected,
      protectedTargetUserApproval: this.#protectedTargetApproved(run),
    });
  }

  cleanupFacts(story: StoryState, snapshot: ControllerSnapshot): CleanupFacts {
    const run = snapshot.run;
    const writerAgent =
      story.assignedAgentId === null
        ? null
        : (snapshot.agents.find(
            (agent) => agent.id === story.assignedAgentId,
          ) ?? null);

    return Object.freeze({
      operationId: `cleanup-${story.id}-${this.#candidateStoryHead(story)}`,
      mergeOperationId: this.#mergeOperationId(story),
      mergeSubject: this.#mergeSubject(story),
      writerLeaseReleased: this.#writerLeaseReleased(run, story),
      agentClosed: writerAgent === null || writerAgent.status === "closed",
      controllerLeaseCurrent: true,
      expectedRevisionMatches: true,
    });
  }
}
