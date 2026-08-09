import {
  planOrchestration,
  reserveAgentLaunchCapacity,
  type OrchestrationAction,
  type OrchestrationStory,
} from "../../domain/orchestration.ts";
import {
  transitionRun,
  type RunState,
  type StoryState,
} from "../../domain/controller-state.ts";
import { countOccupiedAgentSlots } from "../../domain/scheduling.ts";
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

export interface OrchestrationDrainResult {
  readonly ticks: number;
  readonly actions: readonly OrchestrationAction[];
  readonly committed: boolean;
}

export const MAX_ORCHESTRATION_DRAIN_TICKS = 32;

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
  snapshot: ControllerSnapshot,
  dependenciesByStory: ReadonlyMap<string, readonly string[]>,
): OrchestrationStory {
  const reviewer =
    story.reviewerAgentId === null
      ? null
      : (snapshot.agents.find((agent) => agent.id === story.reviewerAgentId) ??
        null);
  return {
    id: story.id,
    status: story.status,
    dependencies: dependenciesByStory.get(story.id) ?? [],
    reviewerAssigned: story.reviewerAgentId !== null,
    reviewerClosed: reviewer?.status === "closed",
    workspaceCleaned: story.workspaceCleaned === true,
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
 * Repeatedly reload and advance one loop until it reaches a durable no-op.
 * The hard limit prevents recursive action storms and turns non-convergence
 * into a fail-closed error rather than an unbounded controller loop.
 */
export async function drainOrchestrationLoop(
  loop: OrchestrationLoop,
  write: FencedWrite,
  maximumTicks = MAX_ORCHESTRATION_DRAIN_TICKS,
): Promise<OrchestrationDrainResult> {
  if (!Number.isSafeInteger(maximumTicks) || maximumTicks < 1) {
    throw new OrchestrationLoopError("orchestration drain limit is invalid");
  }
  const actions: OrchestrationAction[] = [];
  let committed = false;
  for (let tick = 1; tick <= maximumTicks; tick += 1) {
    const result = await loop.tick(write);
    actions.push(...result.actions);
    committed ||= result.committed;
    if (result.actions.length === 0) {
      return Object.freeze({
        ticks: tick,
        actions: Object.freeze(actions),
        committed,
      });
    }
  }
  throw new OrchestrationLoopError(
    `orchestration did not quiesce within ${String(maximumTicks)} ticks`,
  );
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
  #tickQueue: Promise<void> = Promise.resolve();

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

  tick(write: FencedWrite): Promise<OrchestrationTickResult> {
    const execution = this.#tickQueue.then(() => this.#executeTick(write));
    this.#tickQueue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  async #executeTick(write: FencedWrite): Promise<OrchestrationTickResult> {
    const snapshot = this.#repository.loadSnapshot(this.#runId);
    if (
      snapshot === null ||
      TERMINAL_RUN_STATUSES.has(snapshot.run.status) ||
      snapshot.run.status === "planning" ||
      snapshot.run.status === "awaiting-approval" ||
      snapshot.run.status === "blocked"
    ) {
      return Object.freeze({ actions: [], committed: false });
    }

    let current: ControllerSnapshot = snapshot;
    const events: ControllerEventInput[] = [];
    if (snapshot.run.status === "ready") {
      const active = transitionRun(snapshot.run, {
        type: "run-started",
        at: write.now,
        integrationWorktreeReady: true,
      });
      current = Object.freeze({
        revision: snapshot.revision,
        run: active,
        stories: snapshot.stories,
        agents: snapshot.agents,
      });
      events.push({
        eventId: `run-started-${this.#runId}-${String(write.now)}`,
        type: "run-started",
        entityType: "run",
        entityId: this.#runId,
        payload: { integrationWorktreeReady: true },
        occurredAt: write.now,
      });
    }

    const projected = current.stories.map((story) =>
      projectStory(story, current, this.#dependenciesByStory),
    );
    const actions: OrchestrationAction[] = [];
    const primaryStory = current.stories[0];
    if (this.#initialTeam !== null && primaryStory !== undefined) {
      const launchedRoles = new Set(
        current.agents
          .filter((agent) => {
            if (agent.status !== "launching") return true;
            return (
              this.#repository.readAgentLaunch(current.run.id, agent.id)
                ?.status === "confirmed"
            );
          })
          .map((agent) => agent.roleRuntimeId),
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
    actions.push(...planOrchestration(projected, current.run.complexity));
    const capacityDecision = reserveAgentLaunchCapacity(
      actions,
      current.run.complexity,
      countOccupiedAgentSlots(current.agents),
    );
    const admittedActions = capacityDecision.actions;
    if (admittedActions.length === 0 && events.length === 0) {
      return Object.freeze({ actions: admittedActions, committed: false });
    }

    for (const action of admittedActions) {
      const result = await this.#effects.execute(action, current);
      events.push(...result.events);
      current = Object.freeze({
        revision: current.revision,
        run: result.run,
        stories: result.stories,
        agents: result.agents,
      });
    }

    const commit = (base: ControllerSnapshot): boolean => {
      const merged =
        base === snapshot
          ? current
          : mergeAfterConcurrentChildMessage(base, current);
      if (
        base !== snapshot &&
        JSON.stringify({
          run: base.run,
          stories: base.stories,
          agents: base.agents,
        }) ===
          JSON.stringify({
            run: merged.run,
            stories: merged.stories,
            agents: merged.agents,
          })
      ) {
        return false;
      }
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
      return true;
    };
    let committed = false;
    try {
      committed = commit(snapshot);
    } catch (error) {
      if (!isStaleRevision(error)) throw error;
      const latest = this.#repository.loadSnapshot(this.#runId);
      if (latest === null) throw error;
      committed = commit(latest);
    }

    return Object.freeze({ actions: admittedActions, committed });
  }
}
