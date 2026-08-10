import type {
  AgentState,
  AgentStatus,
  RunState,
  StoryState,
  StoryStatus,
} from "../../domain/controller-state.ts";
import type {
  ControllerEventRecord,
  ControllerSnapshot,
} from "../ports/controller-repository.ts";
import {
  projectSupervisorAttention,
  type SupervisorAttentionRow,
} from "./supervisor-attention.ts";

export type AttentionLevel = "normal" | "info" | "warn" | "critical";

/**
 * A working agent that has not reported meaningful progress for this long is
 * called out in the dashboard. This is a presentation signal only: it does
 * not change the agent state or trigger a nudge/escalation.
 */
export const DEFAULT_STALE_PROGRESS_THRESHOLD_MS = 5 * 60_000;

const STORY_ATTENTION: Readonly<Record<StoryStatus, AttentionLevel>> =
  Object.freeze({
    planned: "normal",
    "awaiting-approval": "warn",
    ready: "normal",
    assigned: "info",
    working: "info",
    "awaiting-candidate": "info",
    "awaiting-review": "warn",
    "changes-requested": "warn",
    approved: "normal",
    merging: "info",
    merged: "normal",
    blocked: "critical",
    failed: "critical",
  });

const AGENT_ATTENTION: Readonly<Record<AgentStatus, AttentionLevel>> =
  Object.freeze({
    planned: "normal",
    launching: "info",
    idle: "normal",
    working: "info",
    waiting: "warn",
    blocked: "critical",
    reviewing: "info",
    completed: "normal",
    failed: "critical",
    disconnected: "warn",
    closed: "normal",
  });

export function attentionForStory(status: StoryStatus): AttentionLevel {
  return STORY_ATTENTION[status];
}

export function attentionForAgent(status: AgentStatus): AttentionLevel {
  return AGENT_ATTENTION[status];
}

export interface StoryRow {
  readonly id: string;
  readonly title: string;
  readonly status: StoryStatus;
  readonly branchName: string;
  readonly worktreePath: string;
  readonly assignedAgentId: string | null;
  readonly reviewerAgentId: string | null;
  readonly attention: AttentionLevel;
}

export interface AgentRow {
  readonly id: string;
  readonly role: string;
  readonly status: AgentStatus;
  readonly currentOperation: string | null;
  readonly paneId: string | null;
  readonly attention: AttentionLevel;
}

export interface StaleAgentRow {
  readonly agentId: string;
  readonly role: string;
  readonly status: Extract<AgentStatus, "working" | "reviewing">;
  readonly staleForMs: number;
  readonly lastMeaningfulActivityAt: number;
}

export interface DashboardViewModelOptions {
  /** Current wall-clock time used for stale-progress detection. */
  readonly now?: number;
  /** Override the dashboard-only stale-progress threshold. */
  readonly staleProgressThresholdMs?: number;
}

export interface RunHeader {
  readonly id: string;
  readonly title: string;
  readonly complexity: RunState["complexity"];
  readonly status: RunState["status"];
  readonly storyStatusCounts: Readonly<Record<StoryStatus, number>>;
}

export interface DashboardViewModel {
  readonly revision: number;
  readonly run: RunHeader;
  readonly stories: readonly StoryRow[];
  readonly agents: readonly AgentRow[];
  readonly staleAgents: readonly StaleAgentRow[];
  readonly supervisorAttention: readonly SupervisorAttentionRow[];
}

const STORY_STATUSES: readonly StoryStatus[] = [
  "planned",
  "awaiting-approval",
  "ready",
  "assigned",
  "working",
  "awaiting-candidate",
  "awaiting-review",
  "changes-requested",
  "approved",
  "merging",
  "merged",
  "blocked",
  "failed",
];

function countStoryStatuses(
  stories: readonly StoryState[],
): Readonly<Record<StoryStatus, number>> {
  const counts = Object.fromEntries(
    STORY_STATUSES.map((status) => [status, 0]),
  ) as Record<StoryStatus, number>;
  for (const story of stories) {
    counts[story.status] += 1;
  }
  return Object.freeze(counts);
}

function buildStoryRow(story: StoryState): StoryRow {
  return Object.freeze({
    id: story.id,
    title: story.title,
    status: story.status,
    branchName: story.branchName,
    worktreePath: story.worktreePath,
    assignedAgentId: story.assignedAgentId,
    reviewerAgentId: story.reviewerAgentId,
    attention: attentionForStory(story.status),
  });
}

function buildAgentRow(agent: AgentState): AgentRow {
  return Object.freeze({
    id: agent.id,
    role: agent.roleRuntimeId,
    status: agent.status,
    currentOperation: agent.currentOperation,
    paneId: agent.paneId,
    attention: attentionForAgent(agent.status),
  });
}

function buildStaleAgentRows(
  agents: readonly AgentState[],
  options: DashboardViewModelOptions,
): readonly StaleAgentRow[] {
  const now = options.now;
  if (now === undefined) return Object.freeze([]);
  const threshold =
    options.staleProgressThresholdMs ?? DEFAULT_STALE_PROGRESS_THRESHOLD_MS;
  if (!Number.isFinite(now) || !Number.isFinite(threshold) || threshold <= 0) {
    return Object.freeze([]);
  }
  return Object.freeze(
    agents
      .filter(
        (
          agent,
        ): agent is AgentState & {
          readonly status: "working" | "reviewing";
        } => agent.status === "working" || agent.status === "reviewing",
      )
      .map((agent) => ({
        agentId: agent.id,
        role: agent.roleRuntimeId,
        status: agent.status,
        staleForMs: Math.max(0, now - agent.lastMeaningfulActivityAt),
        lastMeaningfulActivityAt: agent.lastMeaningfulActivityAt,
      }))
      .filter((agent) => agent.staleForMs >= threshold)
      .map((agent) => Object.freeze(agent)),
  );
}

export function formatElapsedDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (totalMinutes < 1) {
    return `${String(Math.floor(Math.max(0, milliseconds) / 1_000))}s`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 1) return `${String(totalMinutes)}m`;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 1) {
    return minutes === 0
      ? `${String(totalHours)}h`
      : `${String(totalHours)}h ${String(minutes)}m`;
  }
  const hours = totalHours % 24;
  return hours === 0
    ? `${String(totalDays)}d`
    : `${String(totalDays)}d ${String(hours)}h`;
}

export function buildDashboardViewModel(
  snapshot: ControllerSnapshot,
  events: readonly ControllerEventRecord[] = [],
  options: DashboardViewModelOptions = {},
): DashboardViewModel {
  return Object.freeze({
    revision: snapshot.revision,
    run: Object.freeze({
      id: snapshot.run.id,
      title: snapshot.run.title,
      complexity: snapshot.run.complexity,
      status: snapshot.run.status,
      storyStatusCounts: countStoryStatuses(snapshot.stories),
    }),
    stories: Object.freeze(snapshot.stories.map(buildStoryRow)),
    agents: Object.freeze(snapshot.agents.map(buildAgentRow)),
    staleAgents: buildStaleAgentRows(snapshot.agents, options),
    supervisorAttention: projectSupervisorAttention(events),
  });
}
