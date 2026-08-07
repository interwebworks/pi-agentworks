import {
  planOrchestration,
  type OrchestrationAction,
  type OrchestrationStory,
} from "../../domain/orchestration.ts";
import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type {
  ControllerEventInput,
  ControllerRepository,
  ControllerSnapshot,
  FencedWrite,
} from "../ports/controller-repository.ts";
import type { OrchestrationEffects } from "../ports/orchestration-effects.ts";

const TERMINAL_RUN_STATUSES: ReadonlySet<RunState["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export interface OrchestrationTickResult {
  readonly actions: readonly OrchestrationAction[];
  readonly committed: boolean;
}

export class OrchestrationLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationLoopError";
  }
}

function isStaleRevision(error: unknown): boolean {
  return error instanceof Error && error.name === "StaleRunRevisionError";
}

function mergeAfterConcurrentChildMessage(
  latest: ControllerSnapshot,
  intended: ControllerSnapshot,
): ControllerSnapshot {
  const agents = intended.agents.map((candidate) => {
    const current = latest.agents.find((agent) => agent.id === candidate.id);
    if (current === undefined) return candidate;
    return current.updatedAt >= candidate.updatedAt ? current : candidate;
  });
  for (const current of latest.agents) {
    if (!agents.some((agent) => agent.id === current.id)) agents.push(current);
  }
  return Object.freeze({
    revision: latest.revision,
    run: intended.run,
    stories: intended.stories,
    agents,
  });
}

function projectStory(
  story: StoryState,
  dependenciesByStory: ReadonlyMap<string, readonly string[]>,
): OrchestrationStory {
  return {
    id: story.id,
    status: story.status,
    dependencies: dependenciesByStory.get(story.id) ?? [],
    reviewerAssigned: story.reviewerAgentId !== null,
  };
}

export interface InitialOrchestrationTeam {
  readonly projectManagerRoleRuntimeId: string;
  readonly advisorRoleRuntimeId: string | null;
}

export interface OrchestrationLoopDependencies {
  readonly repository: ControllerRepository;
  readonly effects: OrchestrationEffects;
  readonly runId: string;
  readonly dependenciesByStory: ReadonlyMap<string, readonly string[]>;
  readonly clock: () => number;
  readonly initialTeam?: InitialOrchestrationTeam;
}

/**
 * Drives one orchestration cycle: load the current snapshot, decide the next
 * actions with the pure `planOrchestration` reducer, carry them out through
 * the injected `OrchestrationEffects` port, and persist the result in a
 * single fenced commit. Actual Git/launcher I/O lives behind the effects
 * port; this loop only sequences and persists.
 */
export class OrchestrationLoop {
  readonly #repository: ControllerRepository;
  readonly #effects: OrchestrationEffects;
  readonly #runId: string;
  readonly #dependenciesByStory: ReadonlyMap<string, readonly string[]>;
  readonly #initialTeam: InitialOrchestrationTeam | null;

  // `clock` is accepted (not merely `write.now`) so callers can source
  // deterministic timestamps for anything they layer on top of a tick (e.g.
  // logging or future loop-authored events) without reaching for
  // `Date.now()` directly. The loop itself only needs the fenced `now` it is
  // handed per tick via `write`.
  constructor(dependencies: OrchestrationLoopDependencies) {
    this.#repository = dependencies.repository;
    this.#effects = dependencies.effects;
    this.#runId = dependencies.runId;
    this.#dependenciesByStory = dependencies.dependenciesByStory;
    this.#initialTeam = dependencies.initialTeam ?? null;
  }

  async tick(write: FencedWrite): Promise<OrchestrationTickResult> {
    const snapshot = this.#repository.loadSnapshot(this.#runId);
    if (snapshot === null || TERMINAL_RUN_STATUSES.has(snapshot.run.status)) {
      return Object.freeze({ actions: [], committed: false });
    }

    const projected = snapshot.stories.map((story) =>
      projectStory(story, this.#dependenciesByStory),
    );
    const actions: OrchestrationAction[] = [];
    const primaryStory = snapshot.stories[0];
    if (this.#initialTeam !== null && primaryStory !== undefined) {
      const launchedRoles = new Set(
        snapshot.agents.map((agent) => agent.roleRuntimeId),
      );
      if (!launchedRoles.has(this.#initialTeam.projectManagerRoleRuntimeId)) {
        actions.push({
          type: "assign-project-manager",
          storyId: primaryStory.id,
        });
      }
      if (
        this.#initialTeam.advisorRoleRuntimeId !== null &&
        !launchedRoles.has(this.#initialTeam.advisorRoleRuntimeId)
      ) {
        actions.push({ type: "assign-advisor", storyId: primaryStory.id });
      }
    }
    actions.push(...planOrchestration(projected, snapshot.run.complexity));
    if (actions.length === 0) {
      return Object.freeze({ actions, committed: false });
    }

    let current: ControllerSnapshot = snapshot;
    const events: ControllerEventInput[] = [];
    for (const action of actions) {
      const result = await this.#effects.execute(action, current);
      events.push(...result.events);
      current = Object.freeze({
        revision: current.revision,
        run: result.run,
        stories: result.stories,
        agents: result.agents,
      });
    }

    const commit = (base: ControllerSnapshot): void => {
      const merged =
        base === snapshot
          ? current
          : mergeAfterConcurrentChildMessage(base, current);
      this.#repository.commitSnapshot({
        write,
        runId: this.#runId,
        expectedRevision: base.revision,
        idempotencyKey: `orchestrate-r${String(base.revision)}`,
        request: { command: "orchestrate", revision: base.revision },
        run: merged.run,
        stories: merged.stories,
        agents: merged.agents,
        events,
      });
    };
    try {
      commit(snapshot);
    } catch (error) {
      if (!isStaleRevision(error)) throw error;
      const latest = this.#repository.loadSnapshot(this.#runId);
      if (latest === null) throw error;
      commit(latest);
    }

    return Object.freeze({ actions, committed: true });
  }
}
