import type { StoryState } from "../../domain/controller-state.ts";
import type { ControllerSnapshot } from "./controller-repository.ts";

/**
 * Runtime facts the merge/cleanup Git operations require that are NOT derivable
 * from the persisted snapshot: live controller-lease/fence status, protected-
 * branch policy, and operation identities/subjects. The candidate commit and
 * merge commit are NOT included here — they are already durable on the story
 * (`candidateStoryHead` is the exact commit `createCandidateCommit` produced;
 * `mergeHead` is the exact commit `mergeCandidate` produced), so the effects
 * adapter reads them straight off `StoryState` instead of duplicating them
 * through this port. The controller runtime — which owns leases and fencing —
 * supplies what remains; keeping it behind a port lets the effects adapter stay
 * pure and fully testable.
 */
export interface MergeFacts {
  readonly operationId: string;
  readonly requesterRole: string;
  readonly subject: string;
  readonly requiredChecksPassed: boolean;
  readonly writerLeaseReleased: boolean;
  readonly controllerLeaseCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
  readonly targetIsDefaultOrProtected: boolean;
  readonly protectedTargetUserApproval: boolean;
}

export interface CleanupFacts {
  readonly operationId: string;
  readonly mergeOperationId: string;
  readonly mergeSubject: string;
  readonly writerLeaseReleased: boolean;
  readonly agentClosed: boolean;
  readonly controllerLeaseCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
}

export interface OrchestrationContext {
  mergeFacts(story: StoryState, snapshot: ControllerSnapshot): MergeFacts;
  cleanupFacts(story: StoryState, snapshot: ControllerSnapshot): CleanupFacts;
}
