import type {
  AgentState,
  AgentStatus,
  RunState,
  StoryState,
  StoryStatus,
} from "./controller-state.ts";

export interface ManagementQuitBlocker {
  readonly entityType: "run" | "story" | "agent";
  readonly entityId: string;
  readonly status: string;
}

export interface ManagementQuitReadiness {
  readonly canQuit: boolean;
  readonly blockers: readonly ManagementQuitBlocker[];
}

const SETTLED_STORY_STATUSES: ReadonlySet<StoryStatus> = new Set([
  "work-complete",
  "merged",
]);

// Idle agents have no outstanding operation. They remain available for the
// controller's delivery lifecycle, but are safe to dismiss once every story's
// current work has finished.
const QUIESCENT_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "idle",
  "completed",
  "closed",
]);

function blocker(
  entityType: ManagementQuitBlocker["entityType"],
  entityId: string,
  status: string,
): ManagementQuitBlocker {
  return Object.freeze({ entityType, entityId, status });
}

/**
 * The management surface may disappear only after every story's agent work is
 * settled and no agent is still active, waiting, disconnected, or broken.
 * This intentionally does not require controller-owned Git submission, review,
 * or merge work to be complete.
 */
export function assessManagementQuitReadiness(input: {
  readonly run: Pick<RunState, "id" | "status">;
  readonly stories: readonly Pick<StoryState, "id" | "status">[];
  readonly agents: readonly Pick<AgentState, "id" | "status">[];
}): ManagementQuitReadiness {
  const blockers: ManagementQuitBlocker[] = [];
  if (input.stories.length === 0) {
    blockers.push(blocker("run", input.run.id, "no-stories"));
  }
  if (["blocked", "failed"].includes(input.run.status)) {
    blockers.push(blocker("run", input.run.id, input.run.status));
  }
  for (const story of input.stories) {
    if (!SETTLED_STORY_STATUSES.has(story.status)) {
      blockers.push(blocker("story", story.id, story.status));
    }
  }
  for (const agent of input.agents) {
    if (!QUIESCENT_AGENT_STATUSES.has(agent.status)) {
      blockers.push(blocker("agent", agent.id, agent.status));
    }
  }
  return Object.freeze({
    canQuit: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
}
