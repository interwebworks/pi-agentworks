import { randomUUID } from "node:crypto";
import {
  createAgentState,
  type AgentState,
  type RunState,
  type StoryState,
} from "../../domain/controller-state.ts";
import type { RoleCatalogEntry } from "./role-resource-resolver.ts";
import type { AssignmentAgentFactory } from "./infrastructure-assignment-resource-provisioner.ts";
import type { StoryAgentKind } from "./assignment-preparation.ts";
import type { ControllerSnapshot } from "../ports/controller-repository.ts";

export class ControllerAgentFactoryError extends Error {
  constructor(message: string) {
    super(`Controller agent factory failed: ${message}`);
    this.name = "ControllerAgentFactoryError";
  }
}

/** Creates an ephemeral, identity-bound agent state before fenced persistence. */
export class ControllerAgentFactory implements AssignmentAgentFactory {
  readonly #clock: () => number;
  readonly #idFactory: () => string;

  constructor(clock: () => number, idFactory: () => string = randomUUID) {
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  create(
    _kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AgentState> {
    const agentId = this.#idFactory();
    if (snapshot.agents.some((agent) => agent.id === agentId)) {
      throw new ControllerAgentFactoryError(
        `agent id ${agentId} already exists`,
      );
    }
    return Promise.resolve(
      createAgentState({
        id: agentId,
        runId: run.id,
        roleRuntimeId: role.runtimeId,
        taskId: story.id,
        worktreePath: story.worktreePath,
        createdAt: this.#clock(),
      }),
    );
  }
}
