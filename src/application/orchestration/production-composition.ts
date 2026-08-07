import type {
  ControllerRepository,
  FencedWrite,
} from "../ports/controller-repository.ts";
import type { GitWorkspaceGateway } from "../ports/git-workspace-gateway.ts";
import type { OrchestrationContext } from "../ports/orchestration-context.ts";
import type { PiAgentLauncher } from "../ports/pi-agent-launcher.ts";
import { ControllerOrchestrationEffects } from "./controller-orchestration-effects.ts";
import {
  OrchestrationLoop,
  type InitialOrchestrationTeam,
} from "./orchestration-loop.ts";
import { DeterministicAssignmentPreparation } from "../launch/assignment-preparation.ts";
import { ControllerOwnedAssignmentResourceProvider } from "../launch/controller-owned-resource-provider.ts";
import type {
  AssignmentAgentFactory,
  AssignmentLaunchConfigurationResolver,
  GitWorkspaceRollback,
} from "../launch/infrastructure-assignment-resource-provisioner.ts";
import { InfrastructureAssignmentResourceProvisioner } from "../launch/infrastructure-assignment-resource-provisioner.ts";
import type { GitAssignmentEvidenceAdapter } from "../launch/git-assignment-evidence-adapter.ts";
import type { HerdrAgentPaneAllocator } from "../launch/herdr-agent-pane-allocator.ts";
import type { PrivateSessionProvider } from "../launch/herdr-session-evidence-adapter.ts";
import {
  ExplicitRoleResourceResolver,
  type AssignmentRoleSelector,
  type RoleCatalog,
} from "../launch/role-resource-resolver.ts";
import { SecureStoryAgentLauncherAdapter } from "../launch/story-agent-launcher-adapter.ts";

export interface ProductionOrchestrationCompositionDependencies {
  readonly repository: ControllerRepository;
  readonly git: GitWorkspaceGateway;
  readonly context: OrchestrationContext;
  readonly runId: string;
  readonly dependenciesByStory: ReadonlyMap<string, readonly string[]>;
  readonly write: FencedWrite;
  readonly clock: () => number;
  readonly piLauncher: PiAgentLauncher;
  readonly roleCatalog: RoleCatalog;
  readonly roleSelector: AssignmentRoleSelector;
  readonly agentFactory: AssignmentAgentFactory;
  readonly gitEvidence: GitAssignmentEvidenceAdapter;
  readonly paneAllocator: HerdrAgentPaneAllocator;
  readonly sessions: PrivateSessionProvider;
  readonly launchConfiguration: AssignmentLaunchConfigurationResolver;
  readonly gitRollback: GitWorkspaceRollback;
  readonly writerLeaseTtlMs: number;
  readonly initialTeam: InitialOrchestrationTeam;
}

export class ProductionOrchestrationCompositionError extends Error {
  constructor(message: string) {
    super(`Production orchestration composition is invalid: ${message}`);
    this.name = "ProductionOrchestrationCompositionError";
  }
}

/**
 * Composition root for one controller run. Every privileged dependency is
 * explicit; callers cannot obtain an executable loop from a partial setup.
 */
export function createProductionOrchestrationLoop(
  dependencies: ProductionOrchestrationCompositionDependencies | null,
): OrchestrationLoop {
  if (dependencies === null) {
    throw new ProductionOrchestrationCompositionError(
      "all controller, Git, role, pane, session, and launcher dependencies are required",
    );
  }
  if (dependencies.runId.trim().length === 0) {
    throw new ProductionOrchestrationCompositionError("run id is empty");
  }
  if (dependencies.writerLeaseTtlMs < 1) {
    throw new ProductionOrchestrationCompositionError(
      "writer lease ttl must be positive",
    );
  }
  if (
    dependencies.initialTeam.projectManagerRoleRuntimeId.trim().length === 0
  ) {
    throw new ProductionOrchestrationCompositionError(
      "Project Manager runtime role id is empty",
    );
  }
  if (
    dependencies.initialTeam.advisorRoleRuntimeId !== null &&
    dependencies.initialTeam.advisorRoleRuntimeId.trim().length === 0
  ) {
    throw new ProductionOrchestrationCompositionError(
      "advisor runtime role id is empty",
    );
  }

  const privilegedResources = new InfrastructureAssignmentResourceProvisioner({
    agents: dependencies.agentFactory,
    git: dependencies.gitEvidence,
    panes: dependencies.paneAllocator,
    sessions: dependencies.sessions,
    configuration: dependencies.launchConfiguration,
    gitRollback: dependencies.gitRollback,
  });
  const resources = new ControllerOwnedAssignmentResourceProvider({
    repository: dependencies.repository,
    write: dependencies.write,
    writerLeaseTtlMs: dependencies.writerLeaseTtlMs,
    provisioner: privilegedResources,
  });
  const preparation = new DeterministicAssignmentPreparation(
    new ExplicitRoleResourceResolver({
      catalog: dependencies.roleCatalog,
      selector: dependencies.roleSelector,
      resources,
    }),
  );
  const launcher = new SecureStoryAgentLauncherAdapter({
    launcher: dependencies.piLauncher,
    preparation,
    clock: dependencies.clock,
  });
  const effects = new ControllerOrchestrationEffects({
    git: dependencies.git,
    launcher,
    context: dependencies.context,
    clock: dependencies.clock,
  });
  return new OrchestrationLoop({
    repository: dependencies.repository,
    effects,
    runId: dependencies.runId,
    dependenciesByStory: dependencies.dependenciesByStory,
    clock: dependencies.clock,
    initialTeam: dependencies.initialTeam,
  });
}
