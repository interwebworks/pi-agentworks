import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type { RoleDefinition } from "../../domain/role-pack.ts";
import type { ControllerSnapshot } from "../ports/controller-repository.ts";
import {
  type AssignmentLaunchResources,
  type AssignmentRoleResolution,
  type AssignmentPreparationResolver,
  type StoryAgentKind,
} from "./assignment-preparation.ts";

export interface RoleCatalogEntry extends RoleDefinition {
  readonly runtimeId: string;
  readonly systemPrompt: string;
}

export interface RoleCatalog {
  find(runtimeId: string): Promise<RoleCatalogEntry | null>;
}

export interface AssignmentRoleSelector {
  select(
    kind: StoryAgentKind,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<string>;
}

/**
 * This provider is the explicit composition point for controller-owned writer
 * leases, Git worktrees, Herdr panes, private sessions, and child tokens.
 * It must return complete evidence; it must not invent defaults.
 */
export interface AssignmentResourceProvider {
  resolve(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentLaunchResources>;
}

export class RoleResourceResolverError extends Error {
  constructor(message: string) {
    super(`Role/resource resolution failed: ${message}`);
    this.name = "RoleResourceResolverError";
  }
}

/** Resolves deterministic role identity before delegating privileged resources. */
export class ExplicitRoleResourceResolver implements AssignmentPreparationResolver {
  readonly #catalog: RoleCatalog;
  readonly #selector: AssignmentRoleSelector;
  readonly #resources: AssignmentResourceProvider;

  constructor(
    dependencies: {
      readonly catalog: RoleCatalog;
      readonly selector: AssignmentRoleSelector;
      readonly resources: AssignmentResourceProvider;
    } | null,
  ) {
    if (dependencies === null) {
      throw new RoleResourceResolverError(
        "role catalog, selector, and resource provider are required",
      );
    }
    this.#catalog = dependencies.catalog;
    this.#selector = dependencies.selector;
    this.#resources = dependencies.resources;
  }

  async resolveRole(
    kind: StoryAgentKind,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentRoleResolution> {
    const runtimeId = await this.#selector.select(kind, story, run, snapshot);
    if (runtimeId.trim().length === 0) {
      throw new RoleResourceResolverError("role selector returned an empty id");
    }
    const role = await this.#catalog.find(runtimeId);
    if (role === null) {
      throw new RoleResourceResolverError(`role ${runtimeId} is unavailable`);
    }
    if (role.runtimeId !== runtimeId || role.systemPrompt.trim().length === 0) {
      throw new RoleResourceResolverError(
        `role ${runtimeId} has invalid identity or prompt evidence`,
      );
    }
    return Object.freeze({
      role,
      runtimeId: role.runtimeId,
      rolePrompt: role.systemPrompt,
    });
  }

  async resolveResources(
    kind: StoryAgentKind,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentLaunchResources> {
    const runtimeId = await this.#selector.select(kind, story, run, snapshot);
    const role = await this.#catalog.find(runtimeId);
    if (role === null) {
      throw new RoleResourceResolverError(`role ${runtimeId} is unavailable`);
    }
    return this.#resources.resolve(kind, role, story, run, snapshot);
  }
}
