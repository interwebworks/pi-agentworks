/**
 * Disconnected-pane detection and session-restoration planning. An agent owns a
 * Herdr pane tagged with an ownership token; if that pane vanishes or is
 * reclaimed by something whose token no longer matches, the agent is
 * disconnected and must be restored — resuming its Pi session when the session
 * file survives, or relaunching fresh when it does not.
 */

/** Agent states that still expect a live, owned pane. */
const ACTIVE_AGENT_STATES = new Set([
  "launching",
  "working",
  "reviewing",
  "idle",
  "waiting",
  "blocked",
  "disconnected",
]);

export interface ExpectedAgentPane {
  readonly agentId: string;
  readonly paneId: string;
  readonly ownershipToken: string;
  readonly sessionPresent: boolean;
  readonly status: string;
}

export interface LivePaneEvidence {
  readonly paneId: string;
  /** Ownership token found in the pane's shell environment, or null if absent. */
  readonly ownershipToken: string | null;
}

export type AgentConnectionState = "connected" | "disconnected" | "inactive";
export type RestorationAction = "none" | "resume-session" | "relaunch-fresh";

export interface AgentConnectionAssessment {
  readonly agentId: string;
  readonly connection: AgentConnectionState;
  readonly restoration: RestorationAction;
  readonly reason: string;
}

function restorationFor(sessionPresent: boolean): RestorationAction {
  return sessionPresent ? "resume-session" : "relaunch-fresh";
}

/**
 * Assess every expected agent against the live panes (keyed by paneId). Only
 * agents in an active state are checked; terminal agents are reported inactive
 * with nothing to restore. The result is deterministic and ordered to match the
 * input.
 */
export function assessAgentConnections(
  expected: readonly ExpectedAgentPane[],
  livePanes: readonly LivePaneEvidence[],
): readonly AgentConnectionAssessment[] {
  const liveById = new Map<string, LivePaneEvidence>();
  for (const pane of livePanes) {
    liveById.set(pane.paneId, pane);
  }

  const decide = (
    agentId: string,
    connection: AgentConnectionState,
    restoration: RestorationAction,
    reason: string,
  ): AgentConnectionAssessment =>
    Object.freeze({ agentId, connection, restoration, reason });

  return Object.freeze(
    expected.map((agent) => {
      if (!ACTIVE_AGENT_STATES.has(agent.status)) {
        return decide(
          agent.agentId,
          "inactive",
          "none",
          `agent state ${agent.status} does not expect a pane`,
        );
      }
      const pane = liveById.get(agent.paneId);
      if (pane === undefined) {
        return decide(
          agent.agentId,
          "disconnected",
          restorationFor(agent.sessionPresent),
          "owned pane is gone",
        );
      }
      if (pane.ownershipToken !== agent.ownershipToken) {
        return decide(
          agent.agentId,
          "disconnected",
          restorationFor(agent.sessionPresent),
          "pane ownership token no longer matches",
        );
      }
      return decide(agent.agentId, "connected", "none", "owned pane is live");
    }),
  );
}

/** The subset of assessments that require a restoration action. */
export function agentsNeedingRestoration(
  assessments: readonly AgentConnectionAssessment[],
): readonly AgentConnectionAssessment[] {
  return Object.freeze(
    assessments.filter((assessment) => assessment.restoration !== "none"),
  );
}
