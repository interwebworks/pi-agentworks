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
 * Launches the interactive Pi agent for a story assignment or review and
 * returns the resulting agent state plus any events. The real implementation
 * (composition root) builds the task specification, acquires the writer lease,
 * and drives the secure Pi launcher; keeping it behind a port lets the effects
 * adapter be tested without a live Pi runtime.
 */
export interface StoryAgentLaunch {
  readonly agent: AgentState;
  readonly events: readonly ControllerEventInput[];
}

export interface StoryAgentLauncher {
  launchWriter(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch>;
  launchReviewer(
    story: StoryState,
    run: RunState,
    snapshot: ControllerSnapshot,
  ): Promise<StoryAgentLaunch>;
}
