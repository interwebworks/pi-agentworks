import type {
  AgentState,
  RunState,
  StoryState,
} from "../../domain/controller-state.ts";
import type { RoleCatalogEntry } from "./role-resource-resolver.ts";
import type {
  AssignmentLaunchResources,
  StoryAgentKind,
} from "./assignment-preparation.ts";
import type {
  AssignmentInfrastructureEvidence,
  GitAssignmentEvidence,
} from "./assignment-resource-evidence.ts";
import { assertAssignmentInfrastructureEvidence } from "./assignment-resource-evidence.ts";
import type { HerdrAgentPaneAllocator } from "./herdr-agent-pane-allocator.ts";
import type { PrivateSessionProvider } from "./herdr-session-evidence-adapter.ts";
import type { GitAssignmentEvidenceAdapter } from "./git-assignment-evidence-adapter.ts";
import type {
  AssignmentPrivilegedResourceProvisioner,
  ProvisionedAssignmentResources,
} from "./controller-owned-resource-provider.ts";
import type { ControllerSnapshot } from "../ports/controller-repository.ts";

export interface AssignmentAgentFactory {
  create(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AgentState>;
}

export interface AssignmentLaunchConfiguration {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly expectedTabId: string | null;
  readonly expectedPaneId: string | null;
  readonly metadataSequence: number;
  readonly sessionId: string;
  readonly controllerSocketPath: string;
  readonly runtimePath: string;
  readonly controllerFenceCurrent: boolean;
  readonly expectedRevisionMatches: boolean;
  readonly piCliPath: string;
  readonly piPackagePath: string;
  readonly agentworksPackagePath: string;
  readonly childBridgePath: string;
  readonly nodePath: string;
  readonly gitMetadataPaths: readonly string[];
  readonly additionalReadOnlyPaths: readonly string[];
  readonly provider: string;
  readonly model: string;
  readonly thinking: AssignmentLaunchResources["thinking"];
}

export interface AssignmentLaunchConfigurationResolver {
  resolve(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    agent: AgentState,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<AssignmentLaunchConfiguration>;
}

export interface GitWorkspaceRollback {
  rollback(
    evidence: GitAssignmentEvidence,
    run: RunState,
    story: StoryState,
    reason: string,
  ): Promise<void>;
}

export class InfrastructureAssignmentProvisionerError extends Error {
  constructor(message: string) {
    super(`Infrastructure assignment provisioning failed: ${message}`);
    this.name = "InfrastructureAssignmentProvisionerError";
  }
}

/** Composes Git, Herdr, session, and launch configuration evidence atomically. */
type GitAssignmentProvisioner = Pick<
  GitAssignmentEvidenceAdapter,
  "provisionGit"
>;
type HerdrAssignmentPaneProvisioner = Pick<
  HerdrAgentPaneAllocator,
  "allocate" | "release"
>;

export class InfrastructureAssignmentResourceProvisioner implements AssignmentPrivilegedResourceProvisioner {
  readonly #agents: AssignmentAgentFactory;
  readonly #git: Pick<GitAssignmentEvidenceAdapter, "provisionGit">;
  readonly #panes: Pick<HerdrAgentPaneAllocator, "allocate" | "release">;
  readonly #sessions: PrivateSessionProvider;
  readonly #configuration: AssignmentLaunchConfigurationResolver;
  readonly #gitRollback: GitWorkspaceRollback;

  constructor(dependencies: {
    readonly agents: AssignmentAgentFactory;
    readonly git: GitAssignmentProvisioner;
    readonly panes: HerdrAssignmentPaneProvisioner;
    readonly sessions: PrivateSessionProvider;
    readonly configuration: AssignmentLaunchConfigurationResolver;
    readonly gitRollback: GitWorkspaceRollback;
  }) {
    this.#agents = dependencies.agents;
    this.#git = dependencies.git;
    this.#panes = dependencies.panes;
    this.#sessions = dependencies.sessions;
    this.#configuration = dependencies.configuration;
    this.#gitRollback = dependencies.gitRollback;
  }

  async provision(
    kind: StoryAgentKind,
    role: RoleCatalogEntry,
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<ProvisionedAssignmentResources> {
    const agent = await this.#agents.create(kind, role, story, run, snapshot);
    const configuration = await this.#configuration.resolve(
      kind,
      role,
      agent,
      story,
      run,
      snapshot,
    );
    const git = this.#git.provisionGit(run, story, snapshot.revision);
    let paneId: string | null = null;
    let session: Awaited<ReturnType<PrivateSessionProvider["create"]>> | null =
      null;
    try {
      const pane = await this.#panes.allocate({
        runId: run.id,
        operationId: configuration.operationId,
        workspaceId: configuration.workspaceId,
        agentId: agent.id,
        label: role.label,
        cwd: story.worktreePath,
        expectedTabId: configuration.expectedTabId,
        expectedPaneId: configuration.expectedPaneId,
        metadataSequence: configuration.metadataSequence,
      });
      paneId = pane.paneId;
      session = await this.#sessions.create(run, story, agent.id);
      const evidence: AssignmentInfrastructureEvidence = {
        git,
        herdr: { paneId, cwd: pane.cwd ?? "", tokens: pane.tokens },
        session,
        controllerSocketPath: configuration.controllerSocketPath,
        runtimePath: configuration.runtimePath,
        controllerFenceCurrent: configuration.controllerFenceCurrent,
        expectedRevisionMatches: configuration.expectedRevisionMatches,
      };
      assertAssignmentInfrastructureEvidence(evidence, run, story, agent.id);
      return Object.freeze({
        agent,
        paneId,
        sessionId: configuration.sessionId,
        sessionPath: session.sessionPath,
        configPath: session.configPath,
        runtimePath: configuration.runtimePath,
        controllerSocketPath: configuration.controllerSocketPath,
        controllerChildAuthToken: session.controllerChildAuthToken,
        piCliPath: configuration.piCliPath,
        piPackagePath: configuration.piPackagePath,
        agentworksPackagePath: configuration.agentworksPackagePath,
        childBridgePath: configuration.childBridgePath,
        nodePath: configuration.nodePath,
        gitMetadataPaths: configuration.gitMetadataPaths,
        additionalReadOnlyPaths: configuration.additionalReadOnlyPaths,
        provider: configuration.provider,
        model: configuration.model,
        thinking: configuration.thinking,
        writerLeaseActive: false,
        controllerFenceCurrent: configuration.controllerFenceCurrent,
        expectedRevisionMatches: configuration.expectedRevisionMatches,
      });
    } catch (error) {
      if (session !== null) {
        await this.#sessions.cleanup(
          session,
          error instanceof Error
            ? error.message
            : "assignment provisioning failed",
        );
      }
      if (paneId !== null) {
        await this.#panes.release(paneId);
      }
      await this.#gitRollback.rollback(
        git,
        run,
        story,
        error instanceof Error
          ? error.message
          : "assignment provisioning failed",
      );
      throw error;
    }
  }

  async rollback(
    resources: ProvisionedAssignmentResources,
    reason: string,
  ): Promise<void> {
    await this.#sessions.cleanup(
      {
        sessionPath: resources.sessionPath,
        configPath: resources.configPath,
        controllerChildAuthToken: resources.controllerChildAuthToken,
      },
      reason,
    );
    await this.#panes.release(resources.paneId);
  }
}
