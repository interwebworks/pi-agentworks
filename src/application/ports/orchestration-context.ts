import type { RunState, StoryState } from "../../domain/controller-state.ts";

/**
 * Runtime facts the merge/cleanup Git operations require that are NOT derivable
 * from the persisted snapshot: the candidate commit the writer produced, the
 * live controller-lease/fence status, protected-branch policy, and operation
 * identities/subjects. The controller runtime — which owns leases, fencing, and
 * candidate bookkeeping — supplies these; keeping them behind a port lets the
 * effects adapter stay pure and fully testable.
 */
export interface MergeFacts {
  readonly operationId: string;
  readonly candidateCommit: string;
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
  readonly candidateCommit: string;
  readonly mergeCommit: string;
  readonly mergeOperationId: string;
  readonly mergeSubject: string;
  readonly writerLeaseReleased: boolean;
  readonly agentClosed: boolean;
  readonly controllerLeaseCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
}

export interface OrchestrationContext {
  mergeFacts(story: StoryState, run: RunState): MergeFacts;
  cleanupFacts(story: StoryState, run: RunState): CleanupFacts;
}
