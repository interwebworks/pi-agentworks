import type { ControllerRepository } from "../ports/controller-repository.ts";
import type { GitWorkspaceGateway } from "../ports/git-workspace-gateway.ts";
import type { OrchestrationContext } from "../ports/orchestration-context.ts";
import type { StoryAgentLauncher } from "../ports/story-agent-launcher.ts";
import { ControllerOrchestrationEffects } from "./controller-orchestration-effects.ts";
import { OrchestrationLoop } from "./orchestration-loop.ts";

export interface LiveOrchestrationCompositionDependencies {
  readonly repository: ControllerRepository;
  readonly git: GitWorkspaceGateway;
  readonly launcher: StoryAgentLauncher;
  readonly context: OrchestrationContext;
  readonly runId: string;
  readonly dependenciesByStory: ReadonlyMap<string, readonly string[]>;
  readonly clock: () => number;
}

export class LiveOrchestrationCompositionError extends Error {
  constructor(message: string) {
    super(`Live orchestration composition is invalid: ${message}`);
    this.name = "LiveOrchestrationCompositionError";
  }
}

function requireDependency(value: unknown, label: string): void {
  if (value === null || value === undefined) {
    throw new LiveOrchestrationCompositionError(`${label} is required`);
  }
}

/**
 * Compose the effectful orchestration loop only when every privileged runtime
 * dependency is explicitly supplied by the controller composition root.
 * The parent extension and controller process intentionally do not call this
 * until a real StoryAgentLauncher is available.
 */
export function createLiveOrchestrationLoop(
  dependencies: LiveOrchestrationCompositionDependencies,
): OrchestrationLoop {
  if (dependencies.runId.trim().length === 0) {
    throw new LiveOrchestrationCompositionError("runId cannot be empty");
  }
  requireDependency(dependencies.repository, "controller repository");
  requireDependency(dependencies.git, "Git workspace gateway");
  requireDependency(dependencies.launcher, "story agent launcher");
  requireDependency(dependencies.context, "orchestration context");
  requireDependency(dependencies.dependenciesByStory, "story dependency map");
  requireDependency(dependencies.clock, "clock");
  return new OrchestrationLoop({
    repository: dependencies.repository,
    effects: new ControllerOrchestrationEffects({
      git: dependencies.git,
      launcher: dependencies.launcher,
      context: dependencies.context,
      clock: dependencies.clock,
    }),
    runId: dependencies.runId,
    dependenciesByStory: dependencies.dependenciesByStory,
    clock: dependencies.clock,
  });
}
