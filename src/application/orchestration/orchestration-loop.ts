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

export interface OrchestrationLoopDependencies {
  readonly repository: ControllerRepository;
  readonly effects: OrchestrationEffects;
  readonly runId: string;
  readonly dependenciesByStory: ReadonlyMap<string, readonly string[]>;
  readonly clock: () => number;
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
  }

  async tick(write: FencedWrite): Promise<OrchestrationTickResult> {
    const snapshot = this.#repository.loadSnapshot(this.#runId);
    if (snapshot === null || TERMINAL_RUN_STATUSES.has(snapshot.run.status)) {
      return Object.freeze({ actions: [], committed: false });
    }

    const projected = snapshot.stories.map((story) =>
      projectStory(story, this.#dependenciesByStory),
    );
    const actions = planOrchestration(projected, snapshot.run.complexity);
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

    this.#repository.commitSnapshot({
      write,
      runId: this.#runId,
      expectedRevision: snapshot.revision,
      idempotencyKey: `orchestrate-r${String(snapshot.revision)}`,
      request: { command: "orchestrate", revision: snapshot.revision },
      run: current.run,
      stories: current.stories,
      agents: current.agents,
      events,
    });

    return Object.freeze({ actions, committed: true });
  }
}
