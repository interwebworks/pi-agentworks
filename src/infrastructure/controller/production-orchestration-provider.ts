import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ControllerOrchestrationExecutor } from "../../controller/process-entry.ts";
import { createProductionOrchestrationLoop } from "../../application/orchestration/production-composition.ts";
import { drainOrchestrationLoop } from "../../application/orchestration/orchestration-loop.ts";
import { ControllerAgentLifecycle } from "../../application/orchestration/controller-agent-lifecycle.ts";
import { IdleAgentSupervisor } from "../../application/orchestration/idle-agent-supervisor.ts";
import { ControllerAgentFactory } from "../../application/launch/controller-agent-factory.ts";
import { EnvironmentLaunchConfigurationResolver } from "../../application/launch/environment-launch-configuration.ts";
import { HerdrAgentPaneAllocator } from "../../application/launch/herdr-agent-pane-allocator.ts";
import { GitAssignmentEvidenceAdapter } from "../../application/launch/git-assignment-evidence-adapter.ts";
import { AgentsTabLifecycle } from "../../application/herdr/agents-tab-lifecycle.ts";
import { LinuxPaneProcessEvidenceGateway } from "../herdr/linux-pane-process-evidence.ts";
import { HerdrCliGateway } from "../herdr/herdr-cli-gateway.ts";
import { GitCliRepositoryInspector } from "../git/git-cli-repository-inspector.ts";
import { GitCliWorkspaceGateway } from "../git/git-cli-workspace-gateway.ts";
import { PrivateAgentSessionProvider } from "../launch/private-agent-session-provider.ts";
import { deriveChildAuthToken } from "./unix-controller-transport.ts";
import { discoverRolePacks } from "../role-packs/file-role-pack-repository.ts";
import { LoadedRoleCatalog } from "../role-packs/loaded-role-catalog.ts";
import { BubblewrapCapabilityDoctor } from "../sandbox/bubblewrap-capability-doctor.ts";
import { BubblewrapSandboxGateway } from "../sandbox/bubblewrap-sandbox-gateway.ts";
import { SecurePiAgentLauncher } from "../../application/launch/secure-pi-agent-launcher.ts";
import { ProductionSandboxLaunchGate } from "../../application/sandbox/production-sandbox-launch-gate.ts";
import { RealOrchestrationContext } from "../../application/orchestration/real-orchestration-context.ts";
import { ControllerRuntimeLaunchEndpointResolver } from "./runtime-orchestration-endpoint.ts";
import type { ControllerRuntime } from "./controller-runtime.ts";
import type {
  FencedWrite,
  JsonValue,
} from "../../application/ports/controller-repository.ts";
import type { AgentMessage } from "../../domain/agent-communication.ts";
import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type { AssignmentRoleSelector } from "../../application/launch/role-resource-resolver.ts";
import type { LoadedRole } from "../role-packs/file-role-pack-repository.ts";
import type { StoryAgentKind } from "../../application/launch/assignment-preparation.ts";
import type { GitAssignmentEvidence } from "../../application/launch/assignment-resource-evidence.ts";
import { composeTeam } from "../../domain/team-composition.ts";
import { DeterministicAssignmentPreparation } from "../../application/launch/assignment-preparation.ts";
import {
  AgentPaneRestorationController,
  type RestorationRepository,
} from "../../application/recovery/agent-pane-restoration.ts";
import {
  createControllerLaunchComposition,
  type ControllerLaunchComposition,
  type ControllerLaunchCompositionEnvironment,
} from "./controller-launch-composition.ts";

export class ProductionOrchestrationProviderError extends Error {
  constructor(message: string) {
    super(`Production orchestration provider failed: ${message}`);
    this.name = "ProductionOrchestrationProviderError";
  }
}

type ProductionEnvironment = ControllerLaunchCompositionEnvironment;
const PRODUCTION_WRITER_LEASE_TTL_MS = 15 * 60_000;

function trustedPrivateSource(path: string, label: string): void {
  const status = lstatSync(path);
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.uid !== process.getuid?.() ||
    status.size > 1024 * 1024
  ) {
    throw new ProductionOrchestrationProviderError(
      `${label} is not a trusted bounded file`,
    );
  }
}

export function installSelectedProviderAuthentication(
  configPath: string,
  providerId: string,
  authenticationPath = join(homedir(), ".pi", "agent", "auth.json"),
): void {
  const destination = join(configPath, "auth.json");
  if (existsSync(destination)) {
    trustedPrivateSource(destination, "private authentication configuration");
    const existing: unknown = JSON.parse(readFileSync(destination, "utf8"));
    if (
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      Object.keys(existing).length === 1 &&
      (existing as Record<string, unknown>)[providerId] !== undefined
    ) {
      return;
    }
    throw new ProductionOrchestrationProviderError(
      "private authentication configuration is not limited to the selected provider",
    );
  }
  const source = authenticationPath;
  if (!existsSync(source)) return;
  trustedPrivateSource(source, "global authentication configuration");
  const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProductionOrchestrationProviderError(
      "global authentication configuration is invalid",
    );
  }
  const credential = (parsed as Record<string, unknown>)[providerId];
  if (credential === undefined) return;
  const content = `${JSON.stringify({ [providerId]: credential }, null, 2)}\n`;
  writeFileSync(destination, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function installSelectedModelConfiguration(
  configPath: string,
  providerId: string,
  modelId: string,
  modelConfigurationPath = join(homedir(), ".pi", "agent", "models.json"),
): void {
  const destination = join(configPath, "models.json");
  if (existsSync(destination)) {
    trustedPrivateSource(destination, "private model configuration");
    const existing: unknown = JSON.parse(readFileSync(destination, "utf8"));
    if (
      existing === null ||
      typeof existing !== "object" ||
      Array.isArray(existing)
    ) {
      throw new ProductionOrchestrationProviderError(
        "private model configuration is invalid",
      );
    }
    const providers = (existing as Record<string, unknown>).providers;
    if (
      providers === null ||
      typeof providers !== "object" ||
      Array.isArray(providers) ||
      Object.keys(providers).length !== 1 ||
      (providers as Record<string, unknown>)[providerId] === undefined
    ) {
      throw new ProductionOrchestrationProviderError(
        "private model configuration differs from the selected provider",
      );
    }
    const selected = (providers as Record<string, unknown>)[providerId];
    if (
      selected === null ||
      typeof selected !== "object" ||
      Array.isArray(selected)
    ) {
      throw new ProductionOrchestrationProviderError(
        "private model configuration has invalid selected-provider evidence",
      );
    }
    const models = (selected as Record<string, unknown>).models;
    if (
      Array.isArray(models) &&
      !models.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).id === modelId,
      )
    ) {
      throw new ProductionOrchestrationProviderError(
        "private model configuration differs from the selected model",
      );
    }
    return;
  }
  const source = modelConfigurationPath;
  if (!existsSync(source)) return;
  trustedPrivateSource(source, "global model configuration");
  const parsed: unknown = JSON.parse(readFileSync(source, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProductionOrchestrationProviderError(
      "global model configuration is invalid",
    );
  }
  const providers = (parsed as Record<string, unknown>).providers;
  if (
    providers === null ||
    typeof providers !== "object" ||
    Array.isArray(providers)
  ) {
    return;
  }
  const selected = (providers as Record<string, unknown>)[providerId];
  if (selected === undefined) return;
  if (
    selected === null ||
    typeof selected !== "object" ||
    Array.isArray(selected)
  ) {
    throw new ProductionOrchestrationProviderError(
      `model provider ${providerId} has invalid configuration`,
    );
  }
  const provider = selected as Record<string, unknown>;
  const models = provider.models;
  const selectedModels = Array.isArray(models)
    ? models.filter(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>).id === modelId,
      )
    : undefined;
  if (Array.isArray(models) && selectedModels?.length !== 1) {
    throw new ProductionOrchestrationProviderError(
      `model ${providerId}/${modelId} is absent from models.json`,
    );
  }
  const content = `${JSON.stringify(
    {
      providers: {
        [providerId]: {
          ...provider,
          ...(selectedModels === undefined ? {} : { models: selectedModels }),
        },
      },
    },
    null,
    2,
  )}\n`;
  writeFileSync(destination, content, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function createLazyProductionOrchestrationExecutor(
  compose: (write: FencedWrite) => Promise<ControllerOrchestrationExecutor>,
): ControllerOrchestrationExecutor {
  return Object.freeze({
    async execute(write: FencedWrite) {
      return (await compose(write)).execute(write);
    },
    async handleAgentMessage(
      message: AgentMessage,
      write: FencedWrite,
      requestId: string,
    ) {
      const operation = await compose(write);
      if (operation.handleAgentMessage === undefined) {
        throw new ProductionOrchestrationProviderError(
          "agent lifecycle handling is absent from the live composition",
        );
      }
      return operation.handleAgentMessage(message, write, requestId);
    },
    async restorePanes(write: FencedWrite) {
      const operation = await compose(write);
      if (operation.restorePanes === undefined) {
        throw new ProductionOrchestrationProviderError(
          "pane restoration is absent from the live composition",
        );
      }
      return operation.restorePanes(write);
    },
  });
}

function supportsPaneRestoration(
  repository: ControllerRuntime["repository"],
): repository is ControllerRuntime["repository"] & RestorationRepository {
  return (
    repository.reserveAgentPaneRestorations !== undefined &&
    repository.bindAgentPaneRestoration !== undefined &&
    repository.confirmAgentPaneRestoration !== undefined &&
    repository.readAgentPaneRestoration !== undefined
  );
}

function chooseRole(
  roles: readonly LoadedRole[],
  kind: StoryAgentKind,
  story: StoryState,
): string {
  const authority =
    kind === "writer"
      ? "worker"
      : kind === "project-manager"
        ? "project-manager"
        : kind;
  const taskKinds = new Set(story.planning?.taskKinds ?? []);
  const candidates = roles
    .filter((role) => role.authority === authority)
    .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
  const selected = candidates
    .map((role) => ({
      role,
      score: role.taskKinds.filter((taskKind) => taskKinds.has(taskKind))
        .length,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.role.runtimeId.localeCompare(right.role.runtimeId),
    )[0]?.role;
  if (selected === undefined) {
    throw new ProductionOrchestrationProviderError(
      `no ${authority} role is available for story ${story.id}`,
    );
  }
  return selected.runtimeId;
}

function ensureIntegrationWorkspace(
  run: RunState,
  inspector: GitCliRepositoryInspector,
  git: GitCliWorkspaceGateway,
): void {
  const inspection = inspector.inspect(run.originalCheckout);
  if (inspection.repositoryRoot !== run.repositoryRoot) {
    throw new ProductionOrchestrationProviderError(
      "run repository does not match live Git inspection",
    );
  }
  const existing = git
    .listWorktrees(run.originalCheckout)
    .find((worktree) => worktree.path === resolve(run.integrationWorktree));
  if (existing !== undefined) {
    if (existing.branch !== run.integrationBranch || existing.head === null) {
      throw new ProductionOrchestrationProviderError(
        "integration worktree evidence does not match the run",
      );
    }
    return;
  }
  if (inspection.headCommit === null) {
    throw new ProductionOrchestrationProviderError(
      "repository has no exact base commit for integration workspace",
    );
  }
  git.createIntegrationWorkspace({
    runId: run.id,
    originalCheckout: run.originalCheckout,
    repositoryRoot: run.repositoryRoot,
    commonGitDirectory: inspection.commonGitDirectory,
    baseBranch: run.baseBranch,
    expectedBaseHead: run.baseCommit ?? inspection.headCommit,
    ...(run.baseCommit === undefined
      ? {}
      : { allowBaseBranchAdvance: true as const }),
    integrationBranch: run.integrationBranch,
    worktreePath: run.integrationWorktree,
  });
}

export function createProductionOrchestrationProviderFromComposition(
  composition: ControllerLaunchComposition,
): (runtime: ControllerRuntime) => ControllerOrchestrationExecutor {
  if (!composition.liveOrchestration) {
    throw new ProductionOrchestrationProviderError(
      "live orchestration composition is disabled",
    );
  }
  const workspaceId = composition.workspaceId ?? "";
  const provider = composition.provider ?? "";
  const model = composition.model ?? "";
  const herdr = new HerdrCliGateway({ herdrPath: composition.herdrPath ?? "" });
  const piCliPath = composition.piCliPath ?? "";
  const piPackagePath = composition.piPackagePath ?? "";
  const agentworksPackagePath = composition.agentworksPackagePath;
  const childBridgePath = composition.childBridgePath;
  const nodePath = composition.nodePath;
  const launchThinking = composition.thinking ?? "high";
  const controllerHomePath = composition.homePath;

  return (runtime) =>
    createLazyProductionOrchestrationExecutor(async (write: FencedWrite) => {
      const descriptor = runtime.descriptor;
      if (descriptor === null) {
        throw new ProductionOrchestrationProviderError(
          "controller runtime is not running",
        );
      }
      const snapshot = runtime.repository.loadSnapshot(descriptor.runId);
      if (snapshot === null) {
        return {
          execute: () => Promise.resolve({ accepted: false, actions: [] }),
          restorePanes: () =>
            Promise.reject(
              new ProductionOrchestrationProviderError(
                "controller run is unavailable",
              ),
            ),
        };
      }
      const run = snapshot.run;
      ensureIntegrationWorkspace(
        run,
        new GitCliRepositoryInspector(),
        new GitCliWorkspaceGateway(),
      );
      const inspector = new GitCliRepositoryInspector();
      const git = new GitCliWorkspaceGateway();
      const discovery = await discoverRolePacks({
        roots: [
          {
            scope: "builtin",
            path: join(agentworksPackagePath, "role-packs"),
          },
          {
            scope: "user",
            path: join(
              controllerHomePath,
              ".config",
              "pi-agentworks",
              "role-packs",
            ),
          },
          {
            scope: "project",
            path: join(run.originalCheckout, "role-packs"),
          },
        ],
        projectTrusted: false,
      });
      if (discovery.diagnostics.length > 0) {
        throw new ProductionOrchestrationProviderError(
          discovery.diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("; "),
        );
      }
      const roles = discovery.packs.flatMap((pack) => pack.roles);
      // Network access is a role capability, never a run-wide switch. The
      // legacy host-network flag is retained in launch evidence for restart
      // compatibility, but it cannot widen isolated roles or task tools.
      const runtimeRoles = roles;
      const team = composeTeam({
        taskText: `${run.title} ${snapshot.stories
          .flatMap((story) => story.planning?.taskKinds ?? [])
          .join(" ")}`,
        mode: run.complexity,
        roles: runtimeRoles,
      });
      const selectedRuntimeIds = new Set(
        team.members.map((member) => member.runtimeId),
      );
      const selectedRoles = runtimeRoles.filter((role) =>
        selectedRuntimeIds.has(role.runtimeId),
      );
      const projectManager = team.members.find(
        (member) => member.authority === "project-manager",
      );
      if (projectManager === undefined) {
        throw new ProductionOrchestrationProviderError(
          "composed team has no Project Manager",
        );
      }
      const advisor = team.members.find(
        (member) => member.authority === "advisor",
      );
      const roleCatalog = new LoadedRoleCatalog(selectedRoles);
      const roleSelector: AssignmentRoleSelector = {
        select: (kind, story) =>
          Promise.resolve(chooseRole(selectedRoles, kind, story)),
      };
      const paneLifecycle = new AgentsTabLifecycle(
        herdr,
        new LinuxPaneProcessEvidenceGateway(herdr),
      );
      const panes = new HerdrAgentPaneAllocator(paneLifecycle, herdr);
      const privateSessions = new PrivateAgentSessionProvider(
        join(dirname(runtime.paths.runtimeDirectory), "sessions"),
        (runId, _storyId, agentId) =>
          deriveChildAuthToken(runtime.authToken, runId, agentId),
      );
      const sessions = {
        async create(
          sessionRun: { readonly id: string },
          sessionStory: { readonly id: string },
          agentId: string,
        ) {
          const session = await privateSessions.create(
            sessionRun,
            sessionStory,
            agentId,
          );
          installSelectedModelConfiguration(
            session.configPath,
            provider,
            model,
            join(controllerHomePath, ".pi", "agent", "models.json"),
          );
          installSelectedProviderAuthentication(
            session.configPath,
            provider,
            join(controllerHomePath, ".pi", "agent", "auth.json"),
          );
          return session;
        },
        cleanup: privateSessions.cleanup.bind(privateSessions),
      };
      const gitInspection = inspector.inspect(run.originalCheckout);
      const gitEvidence = new GitAssignmentEvidenceAdapter({
        inspector,
        git,
        expectedIntegrationHead: {
          resolve: () => {
            const integration = inspector.inspect(run.integrationWorktree);
            if (integration.headCommit === null) {
              throw new ProductionOrchestrationProviderError(
                "integration worktree has no exact head",
              );
            }
            return integration.headCommit;
          },
        },
      });
      const launchConfiguration = new EnvironmentLaunchConfigurationResolver({
        workspaceId,
        expectedTabId: null,
        expectedPaneId: null,
        metadataSequence: snapshot.revision,
        piCliPath,
        piPackagePath,
        agentworksPackagePath,
        childBridgePath,
        nodePath,
        gitMetadataPaths: [
          gitInspection.gitDirectory,
          gitInspection.commonGitDirectory,
          ...snapshot.stories.map((candidate) =>
            join(candidate.worktreePath, ".git"),
          ),
          join(run.integrationWorktree, ".git"),
        ],
        projectManagerGitMetadataPaths: [
          gitInspection.gitDirectory,
          gitInspection.commonGitDirectory,
          join(run.integrationWorktree, ".git"),
        ],
        additionalReadOnlyPaths: [],
        provider,
        model,
        thinking: launchThinking,
        endpoint: new ControllerRuntimeLaunchEndpointResolver(runtime),
        operationId: (kind, _role, story, current) =>
          `${kind}-${story.id}-r${String(current.revision)}`,
        sessionId: (kind, _role, story, current) =>
          stableUuid(`${current.run.id}:${story.id}:${kind}`),
      });
      const sandbox = new BubblewrapSandboxGateway(
        new ProductionSandboxLaunchGate(new BubblewrapCapabilityDoctor()),
      );
      const piLauncher = new SecurePiAgentLauncher(sandbox, herdr);
      const controllerRepository = runtime.repository;
      if (!supportsPaneRestoration(controllerRepository)) {
        throw new ProductionOrchestrationProviderError(
          "controller repository does not support pane restoration reservations",
        );
      }
      const restorationRepository: RestorationRepository = controllerRepository;
      const paneRestoration = new AgentPaneRestorationController({
        repository: restorationRepository,
        herdr,
        processEvidence: new LinuxPaneProcessEvidenceGateway(herdr),
        lifecycle: paneLifecycle,
        launcher: piLauncher,
        resolveRoleLabel: async (agent) => {
          const role = await roleCatalog.find(agent.roleRuntimeId);
          if (role === null) {
            throw new ProductionOrchestrationProviderError(
              `restoration role ${agent.roleRuntimeId} is unavailable`,
            );
          }
          return role.label;
        },
        preparation: {
          async prepare(input) {
            const current = input.snapshot;
            const currentAgent = current.agents.find(
              (agent) => agent.id === input.agent.id,
            );
            if (currentAgent === undefined) {
              throw new ProductionOrchestrationProviderError(
                `restoration agent ${input.agent.id} is absent from the controller roster`,
              );
            }
            const role = await roleCatalog.find(currentAgent.roleRuntimeId);
            if (role === null) {
              throw new ProductionOrchestrationProviderError(
                `restoration role ${currentAgent.roleRuntimeId} is unavailable`,
              );
            }
            const kind: StoryAgentKind =
              role.authority === "project-manager"
                ? "project-manager"
                : role.authority === "advisor"
                  ? "advisor"
                  : role.authority === "reviewer"
                    ? "reviewer"
                    : "writer";
            const sourceStory =
              currentAgent.taskId === null
                ? current.stories[0]
                : current.stories.find(
                    (story) => story.id === currentAgent.taskId,
                  );
            if (sourceStory === undefined) {
              throw new ProductionOrchestrationProviderError(
                `restoration agent ${currentAgent.id} has no exact story authority`,
              );
            }
            const target =
              kind === "project-manager"
                ? Object.freeze({
                    ...sourceStory,
                    id: `${sourceStory.id}-management`,
                    branchName: current.run.integrationBranch,
                    worktreePath: current.run.integrationWorktree,
                  })
                : sourceStory;
            const configuration = await launchConfiguration.resolve(
              kind,
              role,
              currentAgent,
              target,
              current.run,
              current,
            );
            if (configuration.sessionId !== input.sessionId) {
              throw new ProductionOrchestrationProviderError(
                `restoration session ${input.sessionId} conflicts with deterministic launch authority`,
              );
            }
            const session = await sessions.create(
              current.run,
              target,
              currentAgent.id,
            );
            let writerLease =
              kind === "writer"
                ? runtime.repository.readWriterLease(
                    current.run.id,
                    sourceStory.id,
                  )
                : null;
            if (
              kind === "writer" &&
              (writerLease?.ownerAgentId !== currentAgent.id ||
                writerLease.expiresAt === null ||
                writerLease.expiresAt <= write.now)
            ) {
              writerLease = runtime.repository.acquireWriterLease({
                write,
                runId: current.run.id,
                storyId: sourceStory.id,
                ownerAgentId: currentAgent.id,
                ttlMs: PRODUCTION_WRITER_LEASE_TTL_MS,
              });
            }
            const writerLeaseActive =
              kind !== "writer" ||
              (writerLease?.ownerAgentId === currentAgent.id &&
                writerLease.expiresAt !== null &&
                writerLease.expiresAt > write.now);
            const preparation = new DeterministicAssignmentPreparation({
              resolveRole: () =>
                Promise.resolve({
                  role,
                  runtimeId: role.runtimeId,
                  rolePrompt: role.systemPrompt,
                }),
              resolveResources: () =>
                Promise.resolve({
                  agent: currentAgent,
                  paneId: input.paneId,
                  sessionId: input.sessionId,
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
                  additionalReadOnlyPaths:
                    configuration.additionalReadOnlyPaths,
                  provider: configuration.provider,
                  model: configuration.model,
                  thinking: configuration.thinking,
                  writerLeaseActive,
                  controllerFenceCurrent: configuration.controllerFenceCurrent,
                  expectedRevisionMatches:
                    configuration.expectedRevisionMatches,
                }),
            });
            const prepared = await (kind === "project-manager"
              ? preparation.prepareProjectManager(
                  sourceStory,
                  current.run,
                  current,
                )
              : kind === "advisor"
                ? preparation.prepareAdvisor(sourceStory, current.run, current)
                : kind === "reviewer"
                  ? preparation.prepareReviewer(
                      sourceStory,
                      current.run,
                      current,
                    )
                  : preparation.prepareWriter(
                      sourceStory,
                      current.run,
                      current,
                    ));
            return Object.freeze({
              ...prepared.request,
              requireExistingSession: true,
              ...(currentAgent.piSessionPath === null
                ? {}
                : { expectedSessionFile: currentAgent.piSessionPath }),
            });
          },
        },
      });
      const loop = createProductionOrchestrationLoop({
        repository: runtime.repository,
        git,
        context: new RealOrchestrationContext({
          repository: runtime.repository,
          gitInspector: inspector,
        }),
        runId: run.id,
        dependenciesByStory: new Map(
          snapshot.stories.map((story) => [
            story.id,
            story.planning?.dependencies ?? [],
          ]),
        ),
        write,
        clock: Date.now,
        piLauncher,
        roleCatalog,
        roleSelector,
        agentFactory: new ControllerAgentFactory(Date.now),
        gitEvidence,
        paneAllocator: panes,
        sessions,
        launchConfiguration,
        gitRollback: {
          rollback: (evidence: GitAssignmentEvidence, rollbackRun, story) => {
            git.rollbackStoryWorkspace({
              runId: rollbackRun.id,
              storyId: story.id,
              originalCheckout: rollbackRun.originalCheckout,
              storyBranch: evidence.storyBranch,
              storyWorktreePath: evidence.worktreePath,
              expectedStoryHead: evidence.expectedStoryHead,
            });
            return Promise.resolve();
          },
        },
        writerLeaseTtlMs: PRODUCTION_WRITER_LEASE_TTL_MS,
        initialTeam: {
          projectManagerRoleRuntimeId: projectManager.runtimeId,
          advisorRoleRuntimeId: advisor?.runtimeId ?? null,
        },
      });
      const agentLifecycle = new ControllerAgentLifecycle({
        repository: runtime.repository,
        git,
        roleCatalog,
        clock: Date.now,
        writerLeaseTtlMs: PRODUCTION_WRITER_LEASE_TTL_MS,
      });
      const idleSupervisor = new IdleAgentSupervisor({
        repository: runtime.repository,
        herdr,
        clock: Date.now,
      });
      return {
        async execute(currentWrite) {
          const current = runtime.repository.loadSnapshot(run.id);
          if (current !== null) {
            await idleSupervisor.supervise(current, currentWrite);
          }
          const result = await drainOrchestrationLoop(loop, currentWrite);
          return {
            accepted: true,
            committed: result.committed,
            ticks: result.ticks,
            actions: result.actions.map((action) => {
              if ("storyId" in action) {
                return `${action.type}:${action.storyId}`;
              }
              return action.type;
            }),
          };
        },
        async handleAgentMessage(message, currentWrite, requestId) {
          const result = await agentLifecycle.handle(
            message,
            currentWrite,
            requestId,
          );
          return JSON.parse(JSON.stringify(result)) as JsonValue;
        },
        async restorePanes() {
          const result = await paneRestoration.restoreMissingPane({
            runId: descriptor.runId,
            workspaceId,
            write,
            metadataSequence: snapshot.revision,
          });
          return {
            restored: result.restored,
            restorations: result.restorations.map((restoration) => ({
              agentId: restoration.agentId,
              slot: restoration.slot,
              priorPaneId: restoration.priorPaneId,
              replacementPaneId: restoration.replacementPaneId,
              sessionId: restoration.sessionId,
              processIds: [...restoration.processIds],
            })),
            agentId: result.agentId,
            slot: result.slot,
            priorPaneId: result.priorPaneId,
            replacementPaneId: result.replacementPaneId,
            sessionId: result.sessionId,
            processIds: [...result.processIds],
          };
        },
      };
    });
}

export function createProductionOrchestrationProvider(
  environment: ProductionEnvironment,
  packageRoot: string,
): (runtime: ControllerRuntime) => ControllerOrchestrationExecutor {
  return (runtime) => {
    const descriptor = runtime.descriptor;
    if (descriptor === null) {
      throw new ProductionOrchestrationProviderError(
        "controller runtime is not running",
      );
    }
    const composition = createControllerLaunchComposition(
      descriptor.runId,
      environment,
      packageRoot,
    );
    return createProductionOrchestrationProviderFromComposition(composition)(
      runtime,
    );
  };
}
