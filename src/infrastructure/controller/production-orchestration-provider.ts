import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ControllerOrchestrationExecutor } from "../../controller/process-entry.ts";
import { createProductionOrchestrationLoop } from "../../application/orchestration/production-composition.ts";
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
import type { FencedWrite } from "../../application/ports/controller-repository.ts";
import type { RunState, StoryState } from "../../domain/controller-state.ts";
import type { AssignmentRoleSelector } from "../../application/launch/role-resource-resolver.ts";
import type { LoadedRole } from "../role-packs/file-role-pack-repository.ts";
import type { StoryAgentKind } from "../../application/launch/assignment-preparation.ts";
import type { GitAssignmentEvidence } from "../../application/launch/assignment-resource-evidence.ts";
import { composeTeam } from "../../domain/team-composition.ts";

export class ProductionOrchestrationProviderError extends Error {
  constructor(message: string) {
    super(`Production orchestration provider failed: ${message}`);
    this.name = "ProductionOrchestrationProviderError";
  }
}

interface ProductionEnvironment {
  readonly AGENTWORKS_WORKSPACE_ID?: string;
  readonly HERDR_WORKSPACE_ID?: string;
  readonly AGENTWORKS_HERDR_PATH?: string;
  readonly AGENTWORKS_PI_CLI_PATH?: string;
  readonly AGENTWORKS_PI_PACKAGE_PATH?: string;
  readonly PI_PROVIDER?: string;
  readonly PI_MODEL?: string;
  readonly PI_REASONING_LEVEL?: string;
  readonly AGENTWORKS_ALLOW_HOST_NETWORK?: string;
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ProductionOrchestrationProviderError(`${label} is required`);
  }
  return value.trim();
}

function executable(name: string): string {
  try {
    const path = execFileSync("which", [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (path.length === 0) throw new Error("which returned no path");
    return realpathSync(path);
  } catch (error) {
    throw new ProductionOrchestrationProviderError(
      `cannot resolve ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function packageRootFromExecutable(path: string): string {
  let current = dirname(path);
  for (;;) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new ProductionOrchestrationProviderError(
    `cannot find package root for ${path}`,
  );
}

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
  const destination = join(configPath, "auth.json");
  const content = `${JSON.stringify({ [providerId]: credential }, null, 2)}\n`;
  if (existsSync(destination)) {
    trustedPrivateSource(destination, "private authentication configuration");
    const existing: unknown = JSON.parse(readFileSync(destination, "utf8"));
    if (
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      (existing as Record<string, unknown>)[providerId] !== undefined
    ) {
      return;
    }
    writeFileSync(destination, content, { encoding: "utf8", mode: 0o600 });
    return;
  }
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
): void {
  const source = join(homedir(), ".pi", "agent", "models.json");
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
  const destination = join(configPath, "models.json");
  if (existsSync(destination)) {
    if (readFileSync(destination, "utf8") !== content) {
      throw new ProductionOrchestrationProviderError(
        "private model configuration changed during relaunch",
      );
    }
    return;
  }
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

function hostNetworkApproved(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value !== "1") {
    throw new ProductionOrchestrationProviderError(
      "AGENTWORKS_ALLOW_HOST_NETWORK must be exactly 0 or 1",
    );
  }
  return true;
}

function thinking(
  value: string | undefined,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
  const selected = value ?? "high";
  if (
    selected !== "off" &&
    selected !== "minimal" &&
    selected !== "low" &&
    selected !== "medium" &&
    selected !== "high" &&
    selected !== "xhigh" &&
    selected !== "max"
  ) {
    throw new ProductionOrchestrationProviderError(
      `PI_REASONING_LEVEL is invalid: ${selected}`,
    );
  }
  return selected;
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
    expectedBaseHead: inspection.headCommit,
    integrationBranch: run.integrationBranch,
    worktreePath: run.integrationWorktree,
  });
}

export function createProductionOrchestrationProvider(
  environment: ProductionEnvironment,
  packageRoot: string,
): (runtime: ControllerRuntime) => ControllerOrchestrationExecutor {
  const workspaceId = required(
    environment.AGENTWORKS_WORKSPACE_ID ?? environment.HERDR_WORKSPACE_ID,
    "HERDR workspace id (AGENTWORKS_WORKSPACE_ID or HERDR_WORKSPACE_ID)",
  );
  const provider = required(environment.PI_PROVIDER, "PI_PROVIDER");
  const model = required(environment.PI_MODEL, "PI_MODEL");
  const herdr = new HerdrCliGateway({
    herdrPath: environment.AGENTWORKS_HERDR_PATH ?? "herdr",
  });
  const piCliPath = environment.AGENTWORKS_PI_CLI_PATH
    ? realpathSync(resolve(environment.AGENTWORKS_PI_CLI_PATH))
    : executable("pi");
  const piPackagePath = environment.AGENTWORKS_PI_PACKAGE_PATH
    ? realpathSync(resolve(environment.AGENTWORKS_PI_PACKAGE_PATH))
    : packageRootFromExecutable(piCliPath);
  const agentworksPackagePath = realpathSync(resolve(packageRoot));
  const childBridgePath = join(
    agentworksPackagePath,
    "src",
    "extension",
    "child-mode.ts",
  );
  const nodePath = process.execPath;
  const launchThinking = thinking(environment.PI_REASONING_LEVEL);
  const allowHostNetwork = hostNetworkApproved(
    environment.AGENTWORKS_ALLOW_HOST_NETWORK,
  );

  return (runtime) => ({
    async execute(write: FencedWrite) {
      const descriptor = runtime.descriptor;
      if (descriptor === null) {
        throw new ProductionOrchestrationProviderError(
          "controller runtime is not running",
        );
      }
      const snapshot = runtime.repository.loadSnapshot(descriptor.runId);
      if (snapshot === null) {
        return { accepted: false, actions: [] };
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
          { scope: "builtin", path: join(agentworksPackagePath, "role-packs") },
          {
            scope: "user",
            path: join(homedir(), ".config", "pi-agentworks", "role-packs"),
          },
          { scope: "project", path: join(run.originalCheckout, "role-packs") },
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
      const runtimeRoles = allowHostNetwork
        ? roles.map((role) =>
            Object.freeze({ ...role, networkAccess: "required" as const }),
          )
        : roles;
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
          );
          installSelectedProviderAuthentication(session.configPath, provider);
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
        piLauncher: new SecurePiAgentLauncher(sandbox, herdr),
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
        writerLeaseTtlMs: 15_000,
        initialTeam: {
          projectManagerRoleRuntimeId: projectManager.runtimeId,
          advisorRoleRuntimeId: advisor?.runtimeId ?? null,
        },
      });
      const result = await loop.tick(write);
      return {
        accepted: true,
        committed: result.committed,
        actions: result.actions.map((action) => {
          if ("storyId" in action) {
            return `${action.type}:${action.storyId}`;
          }
          return action.type;
        }),
      };
    },
  });
}
