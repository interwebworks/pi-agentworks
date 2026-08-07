import { randomUUID } from "node:crypto";
import type {
  AgentState,
  RunState,
  StoryState,
} from "../../domain/controller-state.ts";
import type {
  ControllerEventInput,
  ControllerSnapshot,
} from "../ports/controller-repository.ts";
import type {
  PiAgentLaunchEvidence,
  PiAgentLauncher,
  PiAgentLaunchRequest,
} from "../ports/pi-agent-launcher.ts";
import type {
  StoryAgentLaunch,
  StoryAgentLauncher,
} from "../ports/story-agent-launcher.ts";

export interface PreparedStoryAgentLaunch {
  readonly request: PiAgentLaunchRequest;
  readonly agent: AgentState;
  readonly events: readonly ControllerEventInput[];
}

/**
 * The composition root supplies role/task generation and lease acquisition.
 * Persisted StoryState intentionally does not contain enough narrative detail
 * to invent a task specification here, so preparation remains an explicit
 * dependency rather than an unsafe fallback.
 */
export interface StoryAgentLaunchPreparation {
  prepareProjectManager(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch>;
  prepareAdvisor(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch>;
  prepareWriter(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch>;
  prepareReviewer(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch>;
}

export interface SecureStoryAgentLauncherAdapterDependencies {
  readonly launcher: PiAgentLauncher;
  readonly preparation: StoryAgentLaunchPreparation;
  readonly clock: () => number;
}

export class StoryAgentLauncherAdapterError extends Error {
  constructor(message: string) {
    super(`Story agent launcher adapter failed: ${message}`);
    this.name = "StoryAgentLauncherAdapterError";
  }
}

/** Bridges explicit assignment preparation to the secure Pi launcher. */
export class SecureStoryAgentLauncherAdapter implements StoryAgentLauncher {
  readonly #launcher: PiAgentLauncher;
  readonly #preparation: StoryAgentLaunchPreparation;
  readonly #clock: () => number;

  constructor(
    dependencies: SecureStoryAgentLauncherAdapterDependencies | null,
  ) {
    if (dependencies === null) {
      throw new StoryAgentLauncherAdapterError(
        "launcher, preparation, and clock are required",
      );
    }
    this.#launcher = dependencies.launcher;
    this.#preparation = dependencies.preparation;
    this.#clock = dependencies.clock;
  }

  launchProjectManager(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch(
      "project-manager",
      this.#preparation.prepareProjectManager(story, run, snapshot),
    );
  }

  launchAdvisor(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch(
      "advisor",
      this.#preparation.prepareAdvisor(story, run, snapshot),
    );
  }

  launchWriter(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch(
      "writer",
      this.#preparation.prepareWriter(story, run, snapshot),
    );
  }

  launchReviewer(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch(
      "reviewer",
      this.#preparation.prepareReviewer(story, run, snapshot),
    );
  }

  async #launch(
    kind: "project-manager" | "advisor" | "writer" | "reviewer",
    preparedPromise: Promise<PreparedStoryAgentLaunch>,
  ): Promise<StoryAgentLaunch> {
    const prepared = await preparedPromise;
    const evidence = await this.#launcher.launch(prepared.request);
    return Object.freeze({
      agent: prepared.agent,
      events: [
        ...prepared.events,
        this.#launchEvent(kind, prepared.agent, evidence),
      ],
    });
  }

  #launchEvent(
    kind: "project-manager" | "advisor" | "writer" | "reviewer",
    agent: AgentState,
    evidence: PiAgentLaunchEvidence,
  ): ControllerEventInput {
    return Object.freeze({
      eventId: randomUUID(),
      type: `agent-${kind}-process-launched`,
      entityType: "agent",
      entityId: agent.id,
      payload: {
        paneId: evidence.paneId,
        sessionId: evidence.sessionId,
        processIds: evidence.processIds,
        rolePromptSha256: evidence.rolePromptSha256,
        taskPromptSha256: evidence.taskPromptSha256,
        commandSha256: evidence.commandSha256,
      },
      occurredAt: this.#clock(),
    });
  }
}
