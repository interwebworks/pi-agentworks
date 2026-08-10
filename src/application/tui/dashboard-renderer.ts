import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatElapsedDuration } from "./dashboard-view-model.ts";
import type {
  AgentRow,
  AttentionLevel,
  DashboardViewModel,
  StoryRow,
} from "./dashboard-view-model.ts";

export interface DashboardRenderOptions {
  readonly width: number;
  readonly height: number;
  readonly plannedActions?: readonly string[];
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

function statusSummary(view: DashboardViewModel): string {
  const counts = Object.entries(view.run.storyStatusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status}:${String(count)}`)
    .join("  ");
  return counts.length === 0 ? "no stories" : counts;
}

function storyLine(story: StoryRow): string {
  const owner = sanitizeDashboardText(story.assignedAgentId ?? "unassigned");
  return `${ATTENTION_MARKER[story.attention]} ${story.status.padEnd(18)} ${owner.padEnd(14)} ${sanitizeDashboardText(story.title)}  [${sanitizeDashboardText(story.branchName)}]`;
}

function agentLine(agent: AgentRow): string {
  const operation = sanitizeDashboardText(agent.currentOperation ?? "idle");
  const pane = sanitizeDashboardText(agent.paneId ?? "no pane");
  return `${ATTENTION_MARKER[agent.attention]} ${agent.status.padEnd(12)} ${sanitizeDashboardText(agent.id).padEnd(16)} ${sanitizeDashboardText(agent.role)}  ${operation}  [${pane}]`;
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
  const attentionLines = [
    ...view.supervisorAttention.map(
      (item) =>
        `! ${sanitizeDashboardText(item.agentId)}: ${sanitizeDashboardText(item.reason)}`,
    ),
    ...view.staleAgents.map(
      (item) =>
        `! ${sanitizeDashboardText(item.agentId)}: no meaningful activity for ${formatElapsedDuration(item.staleForMs)}`,
    ),
  ];
  const lines = [
    `AGENTWORKS  ${sanitizeDashboardText(view.run.id)}  ${view.run.complexity}  ${view.run.status}  rev ${String(view.revision)}`,
    `${sanitizeDashboardText(view.run.title)}${refreshed}`,
    `Stories  ${statusSummary(view)}`,
    `Next     ${next}`,
    "",
    `STORIES (${String(view.stories.length)})`,
    ...view.stories.map(storyLine),
    "",
    `AGENTS (${String(view.agents.length)})`,
    ...view.agents.map(agentLine),
    "",
    `ATTENTION (${String(attentionLines.length)})`,
    ...(attentionLines.length === 0 ? ["  none"] : attentionLines),
    "",
    "q quit  r refresh",
  ];
  return Object.freeze(lines.slice(0, height).map((line) => fit(line, width)));
}
