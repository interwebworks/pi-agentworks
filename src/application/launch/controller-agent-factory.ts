import { createHash } from "node:crypto";
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
  readonly #idFactory: (
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
  ) => string;

  constructor(
    clock: () => number,
    idFactory: (
      kind: StoryAgentKind,
      role: RoleCatalogEntry,
      story: StoryState,
      run: RunState,
    ) => string = (kind, role, story, run) => {
      const hex = createHash("sha256")
        .update(`${run.id}\0${story.id}\0${kind}\0${role.runtimeId}`)
        .digest("hex")
        .slice(0, 32);
      const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(
        16,
      );
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
    },
  ) {
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  create(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AgentState> {
    const agentId = this.#idFactory(kind, role, story, run);
    const existing = snapshot.agents.find((agent) => agent.id === agentId);
    if (existing !== undefined) {
      if (
        existing.runId !== run.id ||
        existing.roleRuntimeId !== role.runtimeId ||
        existing.taskId !== (kind === "project-manager" ? null : story.id)
      ) {
        throw new ControllerAgentFactoryError(
          `agent id ${agentId} already exists with different identity`,
        );
      }
      return Promise.resolve(existing);
    }
    return Promise.resolve(
      createAgentState({
        id: agentId,
        runId: run.id,
        roleRuntimeId: role.runtimeId,
        taskId: kind === "project-manager" ? null : story.id,
        worktreePath:
          kind === "project-manager"
            ? run.integrationWorktree
            : story.worktreePath,
        createdAt: this.#clock(),
      }),
    );
  }
}
