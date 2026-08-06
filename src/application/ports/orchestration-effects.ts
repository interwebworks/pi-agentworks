import type { OrchestrationAction } from "../../domain/orchestration.ts";
import type {
  AgentState,
  RunState,
  StoryState,
} from "../../domain/controller-state.ts";
import type {
  ControllerEventInput,
  ControllerSnapshot,
} from "./controller-repository.ts";

/**
 * The state produced by carrying out a single orchestration action. The
 * orchestration loop folds these back into the snapshot it hands to the next
 * action, then persists the final result in one commit.
 */
export interface OrchestrationEffectResult {
  readonly run: RunState;
  readonly stories: readonly StoryState[];
  readonly agents: readonly AgentState[];
  readonly events: readonly ControllerEventInput[];
}

/**
 * Performs the real-world work behind an orchestration action (launching an
 * agent, requesting a merge, tearing down a worktree, ...) and reports back
 * the resulting state. The loop itself stays pure persistence + sequencing;
 * this port is where Git/launcher I/O belongs.
 */
export interface OrchestrationEffects {
  execute(
    action: OrchestrationAction,
    snapshot: ControllerSnapshot,
  ): Promise<OrchestrationEffectResult>;
}
