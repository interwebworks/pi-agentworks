import type { AgentState, RunState, StoryState } from "./controller-state.ts";

export interface RecoverySnapshot {
  readonly run: RunState;
  readonly stories: readonly StoryState[];
  readonly agents: readonly AgentState[];
}

export type RecoveryReasonCode =
  | "agent-operation-interrupted"
  | "candidate-commit-interrupted"
  | "merge-interrupted"
  | "terminal-run-has-active-agent";

export interface RecoveryReason {
  readonly code: RecoveryReasonCode;
  readonly entityId: string;
}

export interface StartupRecoveryAssessment {
  readonly status: "ready" | "reconciliation-required";
  readonly reasons: readonly RecoveryReason[];
}

const INTERRUPTED_AGENT_STATES = new Set(["launching", "working", "reviewing"]);

export function assessStartupRecovery(
  snapshot: RecoverySnapshot | null,
): StartupRecoveryAssessment {
  if (snapshot === null) {
    return Object.freeze({ status: "ready", reasons: Object.freeze([]) });
  }

  const reasons: RecoveryReason[] = [];
  for (const agent of snapshot.agents) {
    if (INTERRUPTED_AGENT_STATES.has(agent.status)) {
      reasons.push(
        Object.freeze({
          code: ["completed", "failed", "cancelled"].includes(
            snapshot.run.status,
          )
            ? "terminal-run-has-active-agent"
            : "agent-operation-interrupted",
          entityId: agent.id,
        }),
      );
    }
  }
  for (const story of snapshot.stories) {
    if (story.status === "awaiting-candidate") {
      reasons.push(
        Object.freeze({
          code: "candidate-commit-interrupted",
          entityId: story.id,
        }),
      );
    }
    if (story.status === "merging") {
      reasons.push(
        Object.freeze({
          code: "merge-interrupted",
          entityId: story.id,
        }),
      );
    }
  }

  return Object.freeze({
    status: reasons.length === 0 ? "ready" : "reconciliation-required",
    reasons: Object.freeze(reasons),
  });
}

/**
 * Live evidence for one flagged reason, gathered from the Git and Herdr
 * gateways. Every field is optional: a missing field means the gateway could
 * not produce evidence, which is treated conservatively as unresolved rather
 * than assumed safe.
 */
export interface RecoveryEvidence {
  /** The interrupted candidate commit is present on the story branch. */
  readonly candidatePresent?: boolean;
  /** The interrupted merge commit is present on the integration branch. */
  readonly mergePresent?: boolean;
  /** The agent's Herdr pane still exists. */
  readonly paneAlive?: boolean;
}

export type RecoveryEvidenceLookup = (
  reason: RecoveryReason,
) => RecoveryEvidence;

/**
 * - `resolved`: live evidence proves the phase completed (or the entity is
 *   gone), so it no longer blocks new work.
 * - `recovery-required`: live evidence confirms an incomplete external effect
 *   the controller must recover before proceeding.
 * - `unresolved`: no usable evidence; block conservatively.
 */
export type ReconciledDisposition =
  "resolved" | "recovery-required" | "unresolved";

export interface ReconciledReason extends RecoveryReason {
  readonly disposition: ReconciledDisposition;
  readonly detail: string;
}

export interface ReconciledRecoveryAssessment {
  readonly status: "ready" | "reconciliation-required";
  readonly reasons: readonly ReconciledReason[];
}

function reconcileReason(
  reason: RecoveryReason,
  evidence: RecoveryEvidence,
): ReconciledReason {
  const decide = (
    disposition: ReconciledDisposition,
    detail: string,
  ): ReconciledReason => Object.freeze({ ...reason, disposition, detail });

  switch (reason.code) {
    case "candidate-commit-interrupted":
      if (evidence.candidatePresent === true) {
        return decide("resolved", "candidate commit is present in Git");
      }
      if (evidence.candidatePresent === false) {
        return decide("recovery-required", "candidate commit is absent in Git");
      }
      return decide("unresolved", "no Git evidence for the candidate commit");
    case "merge-interrupted":
      if (evidence.mergePresent === true) {
        return decide("resolved", "merge commit is present in Git");
      }
      if (evidence.mergePresent === false) {
        return decide("recovery-required", "merge commit is absent in Git");
      }
      return decide("unresolved", "no Git evidence for the merge commit");
    case "terminal-run-has-active-agent":
      // A terminal run whose agent pane is gone is just a stale active flag.
      if (evidence.paneAlive === false) {
        return decide("resolved", "agent pane is gone on a terminal run");
      }
      if (evidence.paneAlive === true) {
        return decide(
          "recovery-required",
          "a terminal run still has a live agent pane",
        );
      }
      return decide("unresolved", "no Herdr evidence for the agent pane");
    case "agent-operation-interrupted":
      // An interrupted agent always needs a recovery action; live pane
      // evidence only distinguishes reconnect from relaunch.
      if (evidence.paneAlive === true) {
        return decide(
          "recovery-required",
          "agent pane is alive; reconnect required",
        );
      }
      if (evidence.paneAlive === false) {
        return decide(
          "recovery-required",
          "agent pane is gone; relaunch required",
        );
      }
      return decide("unresolved", "no Herdr evidence for the agent pane");
  }
}

/**
 * Refine a persisted-state recovery assessment against live Git and Herdr
 * evidence. Reconciliation can only make the gate more permissive: the run is
 * ready only when every flagged reason is proven resolved. Genuine incomplete
 * effects and ambiguous evidence keep the gate closed.
 */
export function reconcileStartupRecovery(
  assessment: StartupRecoveryAssessment,
  evidenceFor: RecoveryEvidenceLookup,
): ReconciledRecoveryAssessment {
  const reasons = assessment.reasons.map((reason) =>
    reconcileReason(reason, evidenceFor(reason)),
  );
  const blocked = reasons.some((reason) => reason.disposition !== "resolved");
  return Object.freeze({
    status: blocked ? "reconciliation-required" : "ready",
    reasons: Object.freeze(reasons),
  });
}
