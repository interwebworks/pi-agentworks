import type { ComplexityMode } from "./complexity.ts";
import type { StoryStatus } from "./controller-state.ts";
import {
  agentCapacity,
  scheduleStories,
  storyConcurrencyCap,
  type SchedulableStory,
  type StorySchedulingStatus,
} from "./scheduling.ts";

/**
 * The story facts the orchestration tick needs. This is a projection of the
 * controller's StoryState, kept minimal so the reducer stays pure and testable.
 */
export interface OrchestrationStory {
  readonly id: string;
  readonly status: StoryStatus;
  readonly dependencies: readonly string[];
  readonly reviewerAssigned: boolean;
}

export type OrchestrationAction =
  | { readonly type: "assign-project-manager"; readonly storyId: string }
  | { readonly type: "assign-advisor"; readonly storyId: string }
  | { readonly type: "assign-story"; readonly storyId: string }
  | { readonly type: "assign-reviewer"; readonly storyId: string }
  | { readonly type: "request-merge"; readonly storyId: string }
  | { readonly type: "request-cleanup"; readonly storyId: string }
  | { readonly type: "complete-run" };

export interface AgentLaunchCapacityDecision {
  readonly actions: readonly OrchestrationAction[];
  readonly occupied: number;
  readonly reserved: number;
  readonly remaining: number;
}

/** All current assignment actions create or recover one active agent slot. */
export function isAgentLaunchAction(action: OrchestrationAction): boolean {
  return action.type.startsWith("assign-");
}

/**
 * Reserve available run-level agent slots for launch actions in their existing
 * deterministic order. Non-launch actions never consume capacity and are not
 * suppressed when the run is at its boundary.
 */
export function reserveAgentLaunchCapacity(
  actions: readonly OrchestrationAction[],
  mode: ComplexityMode,
  occupiedAgentSlots: number,
): AgentLaunchCapacityDecision {
  const capacity = agentCapacity(mode, occupiedAgentSlots);
  let remaining = capacity.available;
  let reserved = 0;
  const admitted: OrchestrationAction[] = [];
  for (const action of actions) {
    if (!isAgentLaunchAction(action)) {
      admitted.push(action);
      continue;
    }
    if (remaining === 0) continue;
    admitted.push(action);
    reserved += 1;
    remaining -= 1;
  }
  return Object.freeze({
    actions: Object.freeze(admitted),
    occupied: capacity.occupied,
    reserved,
    remaining,
  });
}

/**
 * Project a story status onto the scheduler's coarse lifecycle:
 * - `done`: merged into the integration branch (unblocks dependents).
 * - `failed`: failed or blocked (permanently blocks dependents).
 * - `pending`: ready to be assigned to a writer.
 * - `running`: anything in flight (or not yet ready), so dependents wait.
 */
function schedulingStatus(status: StoryStatus): StorySchedulingStatus {
  switch (status) {
    case "merged":
      return "done";
    case "failed":
    case "blocked":
      return "failed";
    case "ready":
      return "pending";
    default:
      return "running";
  }
}

/**
 * Decide the controller's next actions for a run, in a deterministic order:
 * cleanups, merges, and reviewer assignments advance in-flight work first, then
 * dependency-aware scheduling starts new stories within the concurrency cap,
 * and the run completes once every story is merged. Emitting an action does not
 * execute it — the controller loop performs the effect and the next tick
 * observes the result. The optional occupied count applies the configured
 * run-level agent limit after the existing dependency and story-concurrency
 * decisions, so neither of those independent guards is weakened.
 */
export function planOrchestration(
  stories: readonly OrchestrationStory[],
  mode: ComplexityMode,
  occupiedAgentSlots = 0,
): readonly OrchestrationAction[] {
  const actions: OrchestrationAction[] = [];

  for (const story of stories) {
    if (story.status === "merged") {
      actions.push({ type: "request-cleanup", storyId: story.id });
    }
  }
  for (const story of stories) {
    if (story.status === "approved") {
      actions.push({ type: "request-merge", storyId: story.id });
    }
  }
  for (const story of stories) {
    if (story.status === "awaiting-review" && !story.reviewerAssigned) {
      actions.push({ type: "assign-reviewer", storyId: story.id });
    }
  }

  const schedulable: SchedulableStory[] = stories.map((story) => ({
    id: story.id,
    dependencies: story.dependencies,
    status: schedulingStatus(story.status),
  }));
  const decision = scheduleStories(schedulable, storyConcurrencyCap(mode));
  for (const storyId of decision.startable) {
    actions.push({ type: "assign-story", storyId });
  }

  if (
    stories.length > 0 &&
    stories.every((story) => story.status === "merged")
  ) {
    actions.push({ type: "complete-run" });
  }

  return reserveAgentLaunchCapacity(actions, mode, occupiedAgentSlots).actions;
}
