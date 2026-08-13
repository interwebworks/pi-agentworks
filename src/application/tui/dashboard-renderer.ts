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
      return "a approve story  A approve all  x reject  f show Pi Agents  r refresh  q quit";
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

function wrapPlanText(value: string, width: number, indent = "  "): string[] {
  const words = sanitizeDashboardText(value).trim().split(/\s+/u);
  const lines: string[] = [];
  let line = indent;
  for (const word of words) {
    const candidate = line === indent ? `${indent}${word}` : `${line} ${word}`;
    if (candidate.length <= width || line === indent) {
      line = candidate;
    } else {
      lines.push(line);
      line = `${indent}${word}`;
    }
  }
  if (line !== indent) lines.push(line);
  return lines.length === 0 ? [indent] : lines;
}

function selectedStoryPlan(
  view: DashboardViewModel,
  selection: DashboardSelection | undefined,
): StoryRow | undefined {
  if (selection?.section !== "stories") return undefined;
  const story = view.stories[selection.index];
  return story?.planning === undefined ? undefined : story;
}

function storyPlanLines(story: StoryRow, width: number): readonly string[] {
  const planning = story.planning;
  if (planning === undefined) return Object.freeze([]);
  const list = (label: string, values: readonly string[]) => [
    label,
    ...values.flatMap((value) => wrapPlanText(value, width, "  • ")),
  ];
  return Object.freeze([
    `STORY PLAN  ${sanitizeDashboardText(story.id)}  ${sanitizeDashboardText(story.status)}`,
    `USER STORY  ${sanitizeDashboardText(story.title)}`,
    ...wrapPlanText(planning.narrative, width),
    "OBJECTIVE",
    ...wrapPlanText(planning.objective, width),
    ...list("SCOPE INCLUDED", planning.scope.included),
    ...list("SCOPE EXCLUDED", planning.scope.excluded),
    ...list("DELIVERABLES", planning.deliverables),
    ...list("ACCEPTANCE CRITERIA", planning.acceptanceCriteria),
    "VALIDATION",
    ...planning.validation.flatMap((validation) =>
      wrapPlanText(
        `${validation.command} - expected: ${validation.expected}`,
        width,
        "  • ",
      ),
    ),
    ...list("ESCALATE WHEN", planning.escalationConditions),
    planning.dependencies.length === 0
      ? "DEPENDENCIES  none"
      : `DEPENDENCIES  ${planning.dependencies.join(", ")}`,
  ]);
}

function selectedStoryRows(
  stories: readonly StoryRow[],
  selectedIndex: number,
  maximumRows: number,
): readonly StoryRow[] {
  if (maximumRows <= 0 || stories.length === 0) return Object.freeze([]);
  const start = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(maximumRows / 2),
      stories.length - maximumRows,
    ),
  );
  return Object.freeze(stories.slice(start, start + maximumRows));
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
  const selectedPlan = selectedStoryPlan(view, options.selection);
  const planLines =
    selectedPlan === undefined ? [] : storyPlanLines(selectedPlan, width);
  // Reserve the lower half for proposal review before a user makes an approval
  // decision. The upper section remains a concise live-management overview.
  const planHeight =
    planLines.length === 0 || height < 16
      ? 0
      : Math.min(planLines.length, Math.max(10, Math.floor(height * 0.55)));
  const mainHeight = height - planHeight;
  const header = [
    `AGENTWORKS  ${sanitizeDashboardText(view.run.id)}  ${view.run.complexity}  ${view.run.status}  rev ${String(view.revision)}`,
    `${sanitizeDashboardText(view.run.title)}${refreshed}`,
    `Stories  ${statusSummary(view)}`,
    `Next     ${next}`,
    ...(options.notice === undefined || options.notice.length === 0
      ? []
      : [`NOTICE   ${sanitizeDashboardText(options.notice)}`]),
  ];
  const controls = [
    "↑/k ↓/j row  ←/h →/l section  enter focus agent",
    managementControlHint(view.run.status),
  ];
  const selectedStoryIndex =
    options.selection?.section === "stories" ? options.selection.index : 0;
  const storyCapacity = Math.max(
    1,
    mainHeight - header.length - controls.length - 3,
  );
  const visibleStories = selectedStoryRows(
    view.stories,
    selectedStoryIndex,
    storyCapacity,
  );
  const mainLines = [
    ...header,
    "",
    `STORIES (${String(view.stories.length)})`,
    ...visibleStories.map((story) => {
      const index = view.stories.indexOf(story);
      return storyLine(
        story,
        options.selection?.section === "stories" &&
          options.selection.index === index,
        quitBlockerKeys.has(`story:${story.id}`),
      );
    }),
    ...(planHeight > 0
      ? []
      : [
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
        ]),
    "",
    ...controls,
  ];
  const lines = [
    ...mainLines.slice(0, mainHeight),
    ...(planHeight === 0 ? [] : ["", ...planLines.slice(0, planHeight - 1)]),
  ];
  return Object.freeze(lines.slice(0, height).map((line) => fit(line, width)));
}
