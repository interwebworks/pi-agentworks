import { getComplexityPolicy, type ComplexityMode } from "./complexity.ts";

export type StorySchedulingStatus = "pending" | "running" | "done" | "failed";

export interface SchedulableStory {
  readonly id: string;
  readonly dependencies: readonly string[];
  readonly status: StorySchedulingStatus;
}

export interface SchedulingDecision {
  /** Pending stories whose dependencies are all done, capped by capacity. */
  readonly startable: readonly string[];
  /** Pending stories permanently blocked because a dependency failed. */
  readonly blocked: readonly string[];
  readonly runningCount: number;
  readonly capacity: number;
  /** No running work and nothing startable, yet pending stories remain. */
  readonly deadlocked: boolean;
}

export class SchedulingError extends Error {
  constructor(message: string) {
    super(`Agentworks scheduling failed: ${message}`);
    this.name = "SchedulingError";
  }
}

/**
 * The maximum number of stories a mode may run concurrently. The agent limit
 * includes the Project Manager and one reviewer, so the writable-story budget
 * is two fewer; never below one.
 */
export function storyConcurrencyCap(mode: ComplexityMode): number {
  return Math.max(1, getComplexityPolicy(mode).maximumAgents - 2);
}

/**
 * Decide which pending stories may start now. A story is startable only when
 * every dependency is done; if any dependency has failed it is permanently
 * blocked. Startable stories are returned in input order (callers pass them in
 * dependency order) and capped to the remaining concurrency budget.
 */
export function scheduleStories(
  stories: readonly SchedulableStory[],
  maxConcurrent: number,
): SchedulingDecision {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new SchedulingError("maxConcurrent must be a positive integer");
  }

  const status = new Map<string, StorySchedulingStatus>();
  for (const story of stories) {
    if (status.has(story.id)) {
      throw new SchedulingError(`duplicate story id: ${story.id}`);
    }
    status.set(story.id, story.status);
  }
  for (const story of stories) {
    for (const dependency of story.dependencies) {
      if (!status.has(dependency)) {
        throw new SchedulingError(
          `story ${story.id} depends on unknown story ${dependency}`,
        );
      }
    }
  }

  const runningCount = stories.filter(
    (story) => story.status === "running",
  ).length;
  const capacity = Math.max(0, maxConcurrent - runningCount);

  const blocked: string[] = [];
  const ready: string[] = [];
  for (const story of stories) {
    if (story.status !== "pending") continue;
    const dependencyStatuses = story.dependencies.map((id) => status.get(id));
    if (dependencyStatuses.includes("failed")) {
      blocked.push(story.id);
    } else if (dependencyStatuses.every((state) => state === "done")) {
      ready.push(story.id);
    }
  }

  const startable = ready.slice(0, capacity);
  const pendingRemain = stories.some((story) => story.status === "pending");
  const deadlocked =
    pendingRemain && runningCount === 0 && startable.length === 0;

  return Object.freeze({
    startable: Object.freeze(startable),
    blocked: Object.freeze(blocked),
    runningCount,
    capacity,
    deadlocked,
  });
}
