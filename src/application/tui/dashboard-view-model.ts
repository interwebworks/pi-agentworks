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

export function buildDashboardViewModel(
  snapshot: ControllerSnapshot,
  events: readonly ControllerEventRecord[] = [],
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
    supervisorAttention: projectSupervisorAttention(events),
  });
}
