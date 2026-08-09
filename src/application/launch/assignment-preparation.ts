import type {
  AgentState,
  RunState,
  StoryPlanningMetadata,
  StoryState,
} from "../../domain/controller-state.ts";
import {
  buildAssignment,
  type AssignableRole,
  type UserStory,
} from "../../domain/story-planning.ts";
import type { RoleDefinition } from "../../domain/role-pack.ts";
import type { ControllerSnapshot } from "../ports/controller-repository.ts";
import type { PiAgentLaunchRequest } from "../ports/pi-agent-launcher.ts";
import type {
  PreparedStoryAgentLaunch,
  StoryAgentLaunchPreparation,
} from "./story-agent-launcher-adapter.ts";

export type StoryAgentKind =
  "project-manager" | "advisor" | "writer" | "reviewer";

export interface AssignmentRoleResolution {
  readonly role: RoleDefinition;
  readonly runtimeId?: string;
  readonly rolePrompt: string;
}

export interface AssignmentLaunchResources {
  readonly agent: AgentState;
  readonly paneId: string;
  readonly sessionId: string;
  readonly sessionPath: string;
  readonly configPath: string;
  readonly runtimePath: string;
  readonly controllerSocketPath: string;
  readonly controllerChildAuthToken: string;
  readonly piCliPath: string;
  readonly piPackagePath: string;
  readonly agentworksPackagePath: string;
  readonly childBridgePath: string;
  readonly nodePath: string;
  readonly gitMetadataPaths: readonly string[];
  readonly additionalReadOnlyPaths: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly thinking: PiAgentLaunchRequest["thinking"];
  readonly writerLeaseActive: boolean;
  readonly controllerFenceCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
}

export interface AssignmentPreparationResolver {
  resolveRole(
    kind: StoryAgentKind,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentRoleResolution>;
  resolveResources(
    kind: StoryAgentKind,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentLaunchResources>;
}

export class AssignmentPreparationError extends Error {
  constructor(message: string) {
    super(`Assignment preparation failed: ${message}`);
    this.name = "AssignmentPreparationError";
  }
}

function planningStory(story: StoryState): UserStory {
  const planning: StoryPlanningMetadata | undefined = story.planning;
  if (planning === undefined) {
    throw new AssignmentPreparationError(
      `story ${story.id} has no durable planning metadata`,
    );
  }
  return {
    id: story.id,
    title: story.title,
    ...planning,
  };
}

function assignableRole(
  role: RoleDefinition,
  runtimeId?: string,
): AssignableRole {
  return {
    runtimeId: runtimeId ?? role.id,
    writePolicy: role.writePolicy,
    tools: role.tools,
  };
}

/**
 * Converts durable planning data and explicitly resolved runtime evidence into
 * a complete, schema-validated secure Pi launch request.
 */
export class DeterministicAssignmentPreparation implements StoryAgentLaunchPreparation {
  readonly #resolver: AssignmentPreparationResolver;

  constructor(resolver: AssignmentPreparationResolver) {
    this.#resolver = resolver;
  }

  prepareProjectManager(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch> {
    return this.#prepare("project-manager", story, run, snapshot);
  }

  prepareAdvisor(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch> {
    return this.#prepare("advisor", story, run, snapshot);
  }

  prepareWriter(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch> {
    return this.#prepare("writer", story, run, snapshot);
  }

  prepareReviewer(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch> {
    return this.#prepare("reviewer", story, run, snapshot);
  }

  async #prepare(
    kind: StoryAgentKind,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<PreparedStoryAgentLaunch> {
    const [resolvedRole, resources] = await Promise.all([
      this.#resolver.resolveRole(kind, story, run, snapshot),
      this.#resolver.resolveResources(kind, story, run, snapshot),
    ]);
    const role = resolvedRole.role;
    const sourceStory = planningStory(story);
    const assignmentStory =
      kind === "project-manager"
        ? Object.freeze({
            ...sourceStory,
            id: `${story.id}-management`,
            title: `Manage: ${run.title}`,
            objective: `Coordinate the Agentworks run and supervise delivery of: ${run.title}`,
            writable: false,
            deliverables: [
              "Coordinate the team, monitor dependencies, and report material decisions or blockers",
            ],
          })
        : kind === "reviewer"
          ? this.#reviewAssignment(sourceStory, story)
          : sourceStory;
    const task = buildAssignment({
      runId: run.id,
      story: assignmentStory,
      role: assignableRole(role, resolvedRole.runtimeId),
      agentId: resources.agent.id,
      repositoryRoot: run.repositoryRoot,
      branchName:
        kind === "project-manager" ? run.integrationBranch : story.branchName,
      worktreePath:
        kind === "project-manager"
          ? run.integrationWorktree
          : story.worktreePath,
      baseBranch:
        kind === "project-manager" ? run.baseBranch : run.integrationBranch,
    });
    return Object.freeze({
      agent: resources.agent,
      events: [],
      request: {
        complexity: run.complexity,
        paneId: resources.paneId,
        task,
        role,
        rolePrompt: resolvedRole.rolePrompt,
        provider: resources.provider,
        model: resources.model,
        thinking: resources.thinking,
        sessionId: resources.sessionId,
        sessionPath: resources.sessionPath,
        configPath: resources.configPath,
        runtimePath: resources.runtimePath,
        controllerSocketPath: resources.controllerSocketPath,
        controllerChildAuthToken: resources.controllerChildAuthToken,
        piCliPath: resources.piCliPath,
        piPackagePath: resources.piPackagePath,
        agentworksPackagePath: resources.agentworksPackagePath,
        childBridgePath: resources.childBridgePath,
        nodePath: resources.nodePath,
        gitMetadataPaths: resources.gitMetadataPaths,
        additionalReadOnlyPaths: resources.additionalReadOnlyPaths,
        writerLeaseActive: resources.writerLeaseActive,
        controllerFenceCurrent: resources.controllerFenceCurrent,
        expectedRevisionMatches: resources.expectedRevisionMatches,
      },
    });
  }

  #reviewAssignment(source: UserStory, story: StoryState): UserStory {
    if (
      story.candidateStoryHead === null ||
      story.reviewedIntegrationHead === null
    ) {
      throw new AssignmentPreparationError(
        `story ${story.id} lacks exact candidate review heads`,
      );
    }
    return Object.freeze({
      ...source,
      writable: false,
      constraints: Object.freeze([
        ...source.constraints,
        `Review exactly candidate HEAD ${story.candidateStoryHead} against integration HEAD ${story.reviewedIntegrationHead}.`,
        "Submit the decision with agentworks_submit_review using those exact controller-supplied heads.",
      ]),
    });
  }
}
