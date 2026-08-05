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
