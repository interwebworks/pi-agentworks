import { createHash } from "node:crypto";
import type {
  AgentState,
  RunState,
  StoryState,
} from "../../domain/controller-state.ts";
import type {
  ConfirmAgentLaunchInput,
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

export interface AgentLaunchAuthority {
  confirmAgentLaunch(input: ConfirmAgentLaunchInput): unknown;
}

export interface SecureStoryAgentLauncherAdapterDependencies {
  readonly launcher: PiAgentLauncher;
  readonly preparation: StoryAgentLaunchPreparation;
  readonly launchAuthority: AgentLaunchAuthority;
  readonly write: ConfirmAgentLaunchInput["write"];
  readonly clock: () => number;
}

const launchOperations = new WeakMap<
  object,
  Map<string, Promise<StoryAgentLaunch>>
>();

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
  readonly #launchAuthority: AgentLaunchAuthority;
  readonly #write: ConfirmAgentLaunchInput["write"];
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
    this.#launchAuthority = dependencies.launchAuthority;
    this.#write = dependencies.write;
    this.#clock = dependencies.clock;
  }

  launchProjectManager(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch("project-manager", story, run, () =>
      this.#preparation.prepareProjectManager(story, run, snapshot),
    );
  }

  launchAdvisor(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch("advisor", story, run, () =>
      this.#preparation.prepareAdvisor(story, run, snapshot),
    );
  }

  launchWriter(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch("writer", story, run, () =>
      this.#preparation.prepareWriter(story, run, snapshot),
    );
  }

  launchReviewer(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch> {
    return this.#launch("reviewer", story, run, () =>
      this.#preparation.prepareReviewer(story, run, snapshot),
    );
  }

  #launch(
    kind: "project-manager" | "advisor" | "writer" | "reviewer",
    story: StoryState,
    run: RunState,
    prepare: () => Promise<PreparedStoryAgentLaunch>,
  ): Promise<StoryAgentLaunch> {
    const key = `${run.id}\0${story.id}\0${kind}`;
    let operations = launchOperations.get(this.#launchAuthority);
    if (operations === undefined) {
      operations = new Map();
      launchOperations.set(this.#launchAuthority, operations);
    }
    const current = operations.get(key);
    if (current !== undefined) return current;

    const operation = this.#launchOnce(kind, prepare).finally(() => {
      if (operations.get(key) === operation) operations.delete(key);
    });
    operations.set(key, operation);
    return operation;
  }

  async #launchOnce(
    kind: "project-manager" | "advisor" | "writer" | "reviewer",
    prepare: () => Promise<PreparedStoryAgentLaunch>,
  ): Promise<StoryAgentLaunch> {
    const prepared = await prepare();
    const evidence = await this.#launcher.launch(prepared.request);
    if (
      evidence.paneId !== prepared.request.paneId ||
      evidence.sessionId !== prepared.request.sessionId
    ) {
      throw new StoryAgentLauncherAdapterError(
        "secure Pi evidence does not match the materialized pane and session",
      );
    }
    const deterministicEvidence = Object.freeze({
      ...evidence,
      processIds: Object.freeze(
        [...evidence.processIds].sort((left, right) => left - right),
      ),
    });
    this.#launchAuthority.confirmAgentLaunch({
      write: this.#write,
      runId: prepared.agent.runId,
      agentId: prepared.agent.id,
      paneId: deterministicEvidence.paneId,
      sessionId: deterministicEvidence.sessionId,
      processIds: deterministicEvidence.processIds,
      commandSha256: deterministicEvidence.commandSha256,
    });
    return Object.freeze({
      agent: prepared.agent,
      events: [
        ...prepared.events,
        this.#launchEvent(kind, prepared.agent, deterministicEvidence),
      ],
    });
  }

  #launchEvent(
    kind: "project-manager" | "advisor" | "writer" | "reviewer",
    agent: AgentState,
    evidence: PiAgentLaunchEvidence,
  ): ControllerEventInput {
    return Object.freeze({
      eventId: createHash("sha256")
        .update(
          `${agent.runId}\0${agent.id}\0${kind}\0${evidence.paneId}\0${evidence.sessionId}\0${evidence.commandSha256}\0${evidence.processIds.join(",")}`,
        )
        .digest("hex"),
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
