import { join } from "node:path";
import type {
  AgentState,
  RunState,
  StoryState,
} from "../../domain/controller-state.ts";
import type { ControllerSnapshot } from "../ports/controller-repository.ts";
import type { RoleModelAssociationResolver } from "../ports/model-association-repository.ts";
import type { RoleCatalogEntry } from "./role-resource-resolver.ts";
import type { StoryAgentKind } from "./assignment-preparation.ts";
import type {
  AssignmentLaunchConfiguration,
  AssignmentLaunchConfigurationResolver,
} from "./infrastructure-assignment-resource-provisioner.ts";

export interface ControllerLaunchEndpointResolver {
  resolve(
    run: RunState,
    story: StoryState,
    snapshot: ControllerSnapshot,
  ): Pick<
    AssignmentLaunchConfiguration,
    | "controllerSocketPath"
    | "runtimePath"
    | "controllerFenceCurrent"
    | "expectedRevisionMatches"
  >;
}

export interface EnvironmentLaunchConfigurationOptions {
  readonly workspaceId: string;
  readonly expectedTabId: string | null;
  readonly expectedPaneId: string | null;
  readonly metadataSequence: number;
  readonly piCliPath: string;
  readonly piPackagePath: string;
  readonly agentworksPackagePath: string;
  readonly childBridgePath: string;
  readonly nodePath: string;
  readonly gitMetadataPaths: readonly string[];
  readonly projectManagerGitMetadataPaths?: readonly string[];
  readonly additionalReadOnlyPaths: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly thinking: AssignmentLaunchConfiguration["thinking"];
  readonly endpoint: ControllerLaunchEndpointResolver;
  readonly operationId: (
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    snapshot: ControllerSnapshot,
  ) => string;
  readonly sessionId: (
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    snapshot: ControllerSnapshot,
  ) => string;
  /**
   * Optional resolver that maps each role to a provider/model/thinking
   * override. When omitted, every role receives the runtime default.
   */
  readonly modelAssociationResolver?: RoleModelAssociationResolver;
}

export class EnvironmentLaunchConfigurationError extends Error {
  constructor(message: string) {
    super(`Launch configuration is invalid: ${message}`);
    this.name = "EnvironmentLaunchConfigurationError";
  }
}

function required(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new EnvironmentLaunchConfigurationError(`${label} is empty`);
  }
}

export class EnvironmentLaunchConfigurationResolver implements AssignmentLaunchConfigurationResolver {
  readonly #options: EnvironmentLaunchConfigurationOptions;

  constructor(options: EnvironmentLaunchConfigurationOptions) {
    required(options.workspaceId, "workspace id");
    required(options.piCliPath, "Pi CLI path");
    required(options.piPackagePath, "Pi package path");
    required(options.agentworksPackagePath, "Agentworks package path");
    required(options.childBridgePath, "child bridge path");
    required(options.nodePath, "Node path");
    required(options.provider, "provider");
    required(options.model, "model");
    this.#options = options;
  }

  resolve(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    _agent: AgentState,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentLaunchConfiguration> {
    const operationId = this.#options.operationId(kind, role, story, snapshot);
    const sessionId = this.#options.sessionId(kind, role, story, snapshot);
    required(operationId, "operation id");
    required(sessionId, "session id");
    const endpoint = this.#options.endpoint.resolve(run, story, snapshot);

    const association = this.#options.modelAssociationResolver?.resolve(
      role.runtimeId,
      role.authority,
    );

    return Promise.resolve({
      workspaceId: this.#options.workspaceId,
      operationId,
      expectedTabId: this.#options.expectedTabId,
      expectedPaneId: this.#options.expectedPaneId,
      metadataSequence: this.#options.metadataSequence,
      sessionId,
      ...endpoint,
      piCliPath: this.#options.piCliPath,
      piPackagePath: this.#options.piPackagePath,
      agentworksPackagePath: this.#options.agentworksPackagePath,
      childBridgePath: this.#options.childBridgePath,
      nodePath: this.#options.nodePath,
      gitMetadataPaths:
        kind === "project-manager" &&
        this.#options.projectManagerGitMetadataPaths !== undefined
          ? this.#options.projectManagerGitMetadataPaths
          : Object.freeze([
              ...new Set([
                ...this.#options.gitMetadataPaths,
                join(story.worktreePath, ".git"),
              ]),
            ]),
      additionalReadOnlyPaths: this.#options.additionalReadOnlyPaths,
      provider: association?.provider ?? this.#options.provider,
      model: association?.model ?? this.#options.model,
      thinking: association?.thinking ?? this.#options.thinking,
    });
  }
}
