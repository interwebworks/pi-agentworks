import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatElapsedDuration } from "./dashboard-view-model.ts";
import type {
  AgentRow,
  AttentionLevel,
  DashboardViewModel,
  StoryRow,
} from "./dashboard-view-model.ts";
import type { RunStatus } from "../../domain/controller-state.ts";
import type { ManagementQuitBlocker } from "../../domain/management-quit.ts";

export type DashboardSection = "stories" | "agents" | "attention";

export interface DashboardSelection {
  readonly section: DashboardSection;
  readonly index: number;
}

export interface DashboardRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly plannedActions?: readonly string[];
  /** The keyboard-selected row in the live management dashboard. */
  readonly selection?: DashboardSelection;
  /** Brief feedback from a user-initiated management control. */
  readonly notice?: string;
  /** Rows preventing the current management pane from being safely dismissed. */
  readonly quitBlockers?: readonly ManagementQuitBlocker[];
  readonly refreshedAt?: number;
}

const ATTENTION_MARKER: Readonly<Record<AttentionLevel, string>> =
  Object.freeze({
    normal: " ",
    info: "·",
    warn: "!",
    critical: "×",
  });

function boundedDimension(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Remove terminal control bytes before controller-owned text reaches stdout. */
export function sanitizeDashboardText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }).join("");
}

function fit(value: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(sanitizeDashboardText(value), width, "...");
}

/** Show only commands that are valid in the current durable run state. */
export function managementControlHint(status: RunStatus): string {
  switch (status) {
    case "awaiting-approval":
      return "a approve  x reject  f show Pi Agents  r refresh  q quit";
    case "ready":
    case "active":
      return "p pause  f show Pi Agents  r refresh  q quit";
    case "blocked":
      return "p resume  f show Pi Agents  r refresh  q quit";
    default:
      return "f show Pi Agents  r refresh  q quit";
  }
}

function statusSummary(view: DashboardViewModel): string {
  const counts = Object.entries(view.run.storyStatusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}:${String(count)}`)
    .join("  ");
  return counts.length === 0 ? "no stories" : counts;
}

function rowMarker(
  level: AttentionLevel,
  selected: boolean,
  quitBlocked: boolean,
): string {
  if (quitBlocked) return selected ? ">×" : "×";
  return selected ? ">" : ATTENTION_MARKER[level];
}

function storyLine(
  story: StoryRow,
  selected: boolean,
  quitBlocked: boolean,
): string {
  const owner = sanitizeDashboardText(story.assignedAgentId ?? "unassigned");
  return `${rowMarker(story.attention, selected, quitBlocked)} ${story.status.padEnd(18)} ${owner.padEnd(14)} ${sanitizeDashboardText(story.title)}  [${sanitizeDashboardText(story.branchName)}]`;
}

function agentLine(
  agent: AgentRow,
  selected: boolean,
  quitBlocked: boolean,
): string {
  const operation = sanitizeDashboardText(agent.currentOperation ?? "idle");
  const pane = sanitizeDashboardText(agent.paneId ?? "no pane");
  return `${rowMarker(agent.attention, selected, quitBlocked)} ${agent.status.padEnd(12)} ${sanitizeDashboardText(agent.id).padEnd(16)} ${sanitizeDashboardText(agent.role)}  ${operation}  [${pane}]`;
}

/** Render a bounded, terminal-safe snapshot for the live management pane. */
export function renderDashboard(
  view: DashboardViewModel,
  options: DashboardRenderOptions,
): readonly string[] {
  const width = boundedDimension(options.width, 100);
  const height = boundedDimension(options.height, 30);
  const plannedActions = options.plannedActions?.join(", ");
  const next =
    plannedActions === undefined || plannedActions.length === 0
      ? "none"
      : plannedActions;
  const refreshed =
    options.refreshedAt === undefined
      ? ""
      : `  refreshed ${new Date(options.refreshedAt).toISOString()}`;
  const quitBlockerKeys = new Set(
    (options.quitBlockers ?? []).map(
      (blocker) => `${blocker.entityType}:${blocker.entityId}`,
    ),
  );
  const attentionLines = [
    ...(view.run.blockedReason === null
      ? []
      : [`× RUN: ${sanitizeDashboardText(view.run.blockedReason)}`]),
    ...view.supervisorAttention.map(
      (item) =>
        `! ${sanitizeDashboardText(item.agentId)}: ${sanitizeDashboardText(item.reason)}`,
    ),
    ...view.staleAgents.map(
      (item) =>
        `! ${sanitizeDashboardText(item.agentId)}: no meaningful activity for ${formatElapsedDuration(item.staleForMs)}`,
    ),
  ].map((line, index) =>
    options.selection?.section === "attention" &&
    options.selection.index === index
      ? `>${line.slice(1)}`
      : line,
  );
  const lines = [
    `AGENTWORKS  ${sanitizeDashboardText(view.run.id)}  ${view.run.complexity}  ${view.run.status}  rev ${String(view.revision)}`,
    `${sanitizeDashboardText(view.run.title)}${refreshed}`,
    `Stories  ${statusSummary(view)}`,
    `Next     ${next}`,
    ...(options.notice === undefined || options.notice.length === 0
      ? []
      : [`NOTICE   ${sanitizeDashboardText(options.notice)}`]),
    "",
    `STORIES (${String(view.stories.length)})`,
    ...view.stories.map((story, index) =>
      storyLine(
        story,
        options.selection?.section === "stories" &&
          options.selection.index === index,
        quitBlockerKeys.has(`story:${story.id}`),
      ),
    ),
    "",
    `AGENTS (${String(view.agents.length)})`,
    ...view.agents.map((agent, index) =>
      agentLine(
        agent,
        options.selection?.section === "agents" &&
          options.selection.index === index,
        quitBlockerKeys.has(`agent:${agent.id}`),
      ),
    ),
    "",
    `ATTENTION (${String(attentionLines.length)})`,
    ...(attentionLines.length === 0 ? ["  none"] : attentionLines),
    "",
    "↑/k ↓/j row  ←/h →/l section  enter focus agent",
    managementControlHint(view.run.status),
  ];
  return Object.freeze(lines.slice(0, height).map((line) => fit(line, width)));
}
